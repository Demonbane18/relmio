import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_REVIEW_FIELDS, createLocalN8nClaudePlan, normalizeLocalN8nClaudePlan,
  validateClaudeReview, createSafeLocalN8nClaudePlan, createSafeLocalN8nClaudeInstallResult,
  createSafeLocalN8nClaudeStatus, createSafeLocalN8nClaudeChangeResult,
} from "../src/domain/local-n8n-claude.js";

const selection = { dockerHost: "unix:///var/run/docker.sock", n8nContainerId: "a".repeat(64),
  n8nContainerName: "fixture-n8n", dockerNetworkId: "b".repeat(64), networkName: "fixture-shared", arch: "arm64" };
const review = Object.fromEntries(CLAUDE_REVIEW_FIELDS.map(key => [key, true]));

test("Claude plan binds exact Docker identities and refuses extra credential fields", () => {
  const plan = createLocalN8nClaudePlan(selection);
  assert.deepEqual(normalizeLocalN8nClaudePlan(plan), plan);
  assert.equal(plan.endpoint, "http://relmio-claude:14502/v1");
  assert.equal(plan.hostPublication, "none");
  for (const extra of [{ key: "secret" }, { oauthToken: "secret" }, { hostPublication: "14502" }, { endpoint: "https://example.test" }]) {
    assert.throws(() => normalizeLocalN8nClaudePlan({ ...plan, ...extra }));
  }
  for (const invalid of [{ arch: "mips" }, { models: [] }, { models: ["claude-fable-5"] },
    { models: ["claude-sonnet-5-5", "claude-sonnet-5-5"] }, { dockerHost: "tcp://example.test:2375" },
    { n8nContainerId: "n8n" }, { dockerNetworkId: "network" }, { networkName: "network\nports:" }]) {
    assert.throws(() => createLocalN8nClaudePlan({ ...selection, ...invalid }));
  }
  const safe = createSafeLocalN8nClaudePlan({ ...plan, disposableHarnessWarning: true });
  assert.equal(Object.hasOwn(safe, "dockerHost"), false);
  assert.equal(safe.disposableHarnessWarning, true);
});

test("every Claude review defaults to refusal and rejects unknown keys", () => {
  assert.deepEqual(validateClaudeReview(review), review);
  for (const key of CLAUDE_REVIEW_FIELDS) {
    assert.throws(() => validateClaudeReview({ ...review, [key]: false }));
    assert.throws(() => validateClaudeReview({ ...review, [key]: "true" }));
  }
  assert.throws(() => validateClaudeReview({ ...review, apiKey: "secret" }));
  assert.throws(() => validateClaudeReview(null));
});

test("Claude views strip non-contract fields and preserve only one-time local key", () => {
  const plan = createLocalN8nClaudePlan(selection);
  const expiresAt = "2026-11-10T00:00:00.000Z";
  const result = { target: plan.target, endpoint: plan.endpoint, baseUrl: plan.baseUrl,
    protocol: plan.protocol, networkName: plan.networkName, n8nContainerName: plan.n8nContainerName,
    hostPublication: "none", clientKey: "d".repeat(64), credentialShownOnce: true,
    deploymentMode: "installed", models: plan.models, expiresAt, oauthToken: "must-not-leak" };
  const safe = createSafeLocalN8nClaudeInstallResult(result, plan);
  assert.equal(safe.clientCredential, result.clientKey);
  assert.equal(JSON.stringify(safe).includes("must-not-leak"), false);
  assert.throws(() => createSafeLocalN8nClaudeInstallResult({ ...result, models: ["claude-other"] }, plan));
  assert.throws(() => createSafeLocalN8nClaudeInstallResult({ ...result, networkName: "other" }, plan));
  const snapshot = { target: plan.target, endpoint: plan.endpoint, auth: { configured: true, disclosure: "one-time", token: "must-not-leak" },
    models: plan.models, expiresAt, approvalExpired: true, canRemove: true, runtime: "restarting", clientKey: "must-not-leak" };
  const status = createSafeLocalN8nClaudeStatus({ target: plan.target, managed: true, state: "partial", snapshot });
  assert.equal(status.snapshot.approvalExpired, true);
  assert.equal(status.snapshot.runtime, "restarting");
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  assert.throws(() => createSafeLocalN8nClaudeStatus({ target: plan.target, managed: false, state: "healthy" }));
  // The runtime is a closed list, and only a running companion may be reported healthy.
  for (const runtime of [undefined, "healthy", "paused", true]) {
    assert.throws(() => createSafeLocalN8nClaudeStatus({ target: plan.target, managed: true, state: "partial", snapshot: { ...snapshot, runtime } }));
  }
  for (const runtime of ["starting", "restarting", "unhealthy", "stopped"]) {
    assert.throws(() => createSafeLocalN8nClaudeStatus({ target: plan.target, managed: true, state: "healthy", snapshot: { ...snapshot, runtime } }));
  }
  assert.equal(createSafeLocalN8nClaudeStatus({ target: plan.target, managed: true, state: "healthy", snapshot: { ...snapshot, runtime: "running" } }).snapshot.runtime, "running");
  assert.deepEqual(createSafeLocalN8nClaudeChangeResult({ target: plan.target, removed: true, loginKept: true, token: "secret" }, "remove"),
    { target: plan.target, removed: true, loginKept: true });
  assert.throws(() => createSafeLocalN8nClaudeChangeResult({ target: plan.target, removed: true }, "remove"));
  assert.deepEqual(createSafeLocalN8nClaudeChangeResult({ target: plan.target, changed: true, loginKept: true }, "sign-out"), { target: plan.target, changed: true });
});
