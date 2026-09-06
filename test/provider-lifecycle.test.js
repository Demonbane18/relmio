import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_ACTION_POLICY,
  PROVIDER_PROFILES,
  PROVIDER_TARGET_BINDINGS,
  getProviderActionPolicy,
  getProviderFailurePolicy,
  getProviderProfile,
  getRuntimeProviderProfile,
  getProviderTargetBinding,
} from "../src/domain/provider-lifecycle.js";

test("every bound target resolves to an implemented provider profile", () => {
  for (const binding of Object.values(PROVIDER_TARGET_BINDINGS)) {
    const profile = getRuntimeProviderProfile(binding.profileId);
    assert.equal(profile.availability, "implemented");
    assert.ok(profile.implementedCapabilities.length > 0);
  }
});

test("401 and 403 require owner action without retry or profile switching", () => {
  assert.deepEqual(getProviderFailurePolicy({ kind: "http", statusCode: 401 }), {
    classification: "authentication",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  });
  assert.deepEqual(getProviderFailurePolicy({ kind: "http", statusCode: 403 }), {
    classification: "authorization",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  });
});

test("an unclassified 429 fails closed without retry or profile switching", () => {
  const policy = getProviderFailurePolicy({ kind: "http", statusCode: 429 });

  assert.deepEqual(policy, {
    classification: "rate-limit-or-quota",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  });
  assert.equal(Object.isFrozen(policy), true);
});

test("only an explicitly normalized transient rate limit allows same-profile backoff", () => {
  assert.deepEqual(
    getProviderFailurePolicy({ kind: "transient-rate-limit" }),
    {
      classification: "rate-limit",
      ownerActionRequired: false,
      retry: "same-profile-bounded-backoff",
      automaticProfileSwitch: false,
    },
  );
  assert.deepEqual(
    getProviderFailurePolicy({ kind: "quota-exhausted" }),
    {
      classification: "quota-exhausted",
      ownerActionRequired: true,
      retry: "none",
      automaticProfileSwitch: false,
    },
  );
  assert.deepEqual(
    getProviderFailurePolicy({ kind: "quota-exhausted", statusCode: 402 }),
    getProviderFailurePolicy({ kind: "quota-exhausted" }),
  );
});

test("agent authentication, authorization, and protocol failures fail closed", () => {
  for (const [kind, classification] of [
    ["agent-authentication", "authentication"],
    ["agent-authorization", "authorization"],
    ["agent-protocol", "agent-protocol"],
  ]) {
    assert.deepEqual(getProviderFailurePolicy({ kind }), {
      classification,
      ownerActionRequired: true,
      retry: "none",
      automaticProfileSwitch: false,
    });
  }
});

test("every unknown provider failure also forbids retry and automatic switching", () => {
  for (const statusCode of [400, 404, 408, 500, 502, 503]) {
    const policy = getProviderFailurePolicy({ kind: "http", statusCode });
    assert.equal(policy.automaticProfileSwitch, false);
    assert.equal(policy.retry, "none");
    assert.equal(Object.isFrozen(policy), true);
  }

  for (const value of [
    null,
    {},
    { kind: "http", statusCode: 200 },
    { kind: "http", statusCode: 600 },
    { kind: "transient-rate-limit", statusCode: 403 },
    { kind: "quota-exhausted", statusCode: 200 },
    { kind: "unknown" },
  ]) {
    assert.throws(() => getProviderFailurePolicy(value), /failure status/i);
  }
});



test("OAuth-only provider records and actions remain immutable and explicit", () => {
  assert.deepEqual(Object.keys(PROVIDER_PROFILES), ["openai-codex", "xai-grok-build"]);
  assert.deepEqual(Object.keys(PROVIDER_TARGET_BINDINGS), ["codex-chatgpt", "codex-chat", "xai-grok-build", "n8n-supergrok-oauth"]);
  for (const profile of Object.values(PROVIDER_PROFILES)) {
    assert.equal(profile.authentication.method, "provider-owned-oauth");
    assert.equal(profile.authentication.custody, "provider-agent-runtime");
    assert.equal(Object.isFrozen(profile), true);
  }
  assert.equal(Object.hasOwn(PROVIDER_ACTION_POLICY, "relmio-private-secret"), false);
  for (const action of ["sign-in", "sign-out", "rotate-client-capability"]) {
    assert.equal(getProviderActionPolicy("xai-grok-build", action).automatic, false);
  }
  for (const retired of ["openai-platform", "xai-inference", "openai-api"]) {
    assert.throws(() => getProviderProfile(retired), /profile|binding/i);
  }
});

// The normal SuperGrok runtime uses direct Chat HTTP, with official CLI login.
test("SuperGrok advertises direct client tool calls without changing OAuth custody", () => {
  const profile = getProviderProfile("xai-grok-build");
  assert.deepEqual(profile.adapter, { kind: "inference", protocol: "openai-chat-completions" });
  assert.ok(profile.implementedCapabilities.includes("client-tool-calls"));
  assert.equal(profile.authentication.method, "provider-owned-oauth");
});
