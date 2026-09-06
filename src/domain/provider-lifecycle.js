function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.freeze(value);
}

export const PROVIDER_PROFILES = deepFreeze({
  "openai-codex": {
    id: "openai-codex",
    providerId: "openai",
    label: "OpenAI Codex",
    availability: "implemented",
    adapter: {
      kind: "agent",
      protocol: "codex-app-server-json-rpc",
    },
    authentication: {
      method: "provider-owned-oauth",
      custody: "provider-agent-runtime",
    },
    documentedCapabilities: ["agent-turns", "streaming"],
    implementedCapabilities: ["agent-turns", "streaming"],
  },
  "xai-grok-build": {
    id: "xai-grok-build",
    providerId: "xai",
    label: "SuperGrok",
    availability: "implemented",
    adapter: {
      kind: "inference",
      protocol: "openai-chat-completions",
    },
    authentication: {
      method: "provider-owned-oauth",
      custody: "provider-agent-runtime",
    },
    documentedCapabilities: ["chat-completions", "streaming"],
    implementedCapabilities: ["chat-completions", "streaming", "client-tool-calls"],
  },
});

export const PROVIDER_TARGET_BINDINGS = deepFreeze({
  "codex-chatgpt": {
    profileId: "openai-codex",
    label: "Codex with ChatGPT",
    protocol: "codex-app-server-json-rpc",
    upstreamAuth: "chatgpt-via-codex",
  },
  "codex-chat": {
    profileId: "openai-codex",
    label: "Codex Chat Adapter",
    protocol: "relmio-codex-chat-http",
    upstreamAuth: "chatgpt-via-codex",
  },
  "xai-grok-build": {
    profileId: "xai-grok-build",
    label: "SuperGrok",
    protocol: "relmio-grok-build-chat-http",
    upstreamAuth: "provider-owned-oauth",
  },
  "n8n-supergrok-oauth": {
    profileId: "xai-grok-build",
    label: "SuperGrok for n8n",
    protocol: "openai-chat-completions",
    upstreamAuth: "provider-owned-oauth",
  },
});

const PROVIDER_ACTIONS = new Set([
  "replace-credential",
  "rotate-client-capability",
  "select-profile",
  "sign-in",
  "sign-out",
]);

export const PROVIDER_ACTION_POLICY = deepFreeze({
  "provider-agent-runtime": {
    "rotate-client-capability": {
      initiation: "explicit-owner-action",
      automatic: false,
      credentialEffect: "local-client-only",
    },
    "sign-in": {
      initiation: "explicit-owner-action",
      automatic: false,
      credentialEffect: "provider-runtime-session",
    },
    "sign-out": {
      initiation: "explicit-owner-action",
      automatic: false,
      credentialEffect: "provider-runtime-session",
    },
  },
});

const HTTP_FAILURE_POLICIES = deepFreeze({
  401: {
    classification: "authentication",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  },
  403: {
    classification: "authorization",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  },
  429: {
    classification: "rate-limit-or-quota",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  },
});

const NORMALIZED_FAILURE_POLICIES = deepFreeze({
  "transient-rate-limit": {
    classification: "rate-limit",
    ownerActionRequired: false,
    retry: "same-profile-bounded-backoff",
    automaticProfileSwitch: false,
  },
  "quota-exhausted": {
    classification: "quota-exhausted",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  },
  "agent-authentication": {
    classification: "authentication",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  },
  "agent-authorization": {
    classification: "authorization",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  },
  "agent-protocol": {
    classification: "agent-protocol",
    ownerActionRequired: true,
    retry: "none",
    automaticProfileSwitch: false,
  },
});

const DEFAULT_FAILURE_POLICY = deepFreeze({
  classification: "provider-failure",
  ownerActionRequired: true,
  retry: "none",
  automaticProfileSwitch: false,
});

function getClosedRecord(records, key, message) {
  if (
    typeof key !== "string" ||
    !Object.prototype.hasOwnProperty.call(records, key)
  ) {
    throw new TypeError(message);
  }
  return records[key];
}

export function getProviderProfile(profileId) {
  return getClosedRecord(
    PROVIDER_PROFILES,
    profileId,
    "Provider profile is invalid.",
  );
}

export function getRuntimeProviderProfile(profileId) {
  const profile = getProviderProfile(profileId);
  if (profile.availability !== "implemented") {
    throw new TypeError("Provider profile is not available at runtime.");
  }
  return profile;
}

export function getProviderTargetBinding(targetId) {
  const binding = getClosedRecord(
    PROVIDER_TARGET_BINDINGS,
    targetId,
    "Provider target is invalid.",
  );
  getRuntimeProviderProfile(binding.profileId);
  return binding;
}

export function getProviderFailurePolicy(failure) {
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) {
    throw new TypeError("Provider failure status is invalid.");
  }
  const { kind, statusCode } = failure;
  if (kind === "http") {
    if (
      !Number.isInteger(statusCode) ||
      statusCode < 400 ||
      statusCode > 599
    ) {
      throw new TypeError("Provider failure status is invalid.");
    }
    return HTTP_FAILURE_POLICIES[statusCode] ?? DEFAULT_FAILURE_POLICY;
  }
  if (kind === "transient-rate-limit") {
    if (statusCode !== undefined && statusCode !== 429) {
      throw new TypeError("Provider failure status is invalid.");
    }
    return NORMALIZED_FAILURE_POLICIES[kind];
  }
  if (kind === "quota-exhausted") {
    if (
      statusCode !== undefined &&
      (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599)
    ) {
      throw new TypeError("Provider failure status is invalid.");
    }
    return NORMALIZED_FAILURE_POLICIES[kind];
  }
  if (
    ["agent-authentication", "agent-authorization", "agent-protocol"].includes(
      kind,
    ) &&
    statusCode === undefined
  ) {
    return NORMALIZED_FAILURE_POLICIES[kind];
  }

  throw new TypeError("Provider failure status is invalid.");
}

export function getProviderActionPolicy(profileId, action) {
  const profile = getRuntimeProviderProfile(profileId);
  if (typeof action !== "string" || !PROVIDER_ACTIONS.has(action)) {
    throw new TypeError("Provider action is invalid.");
  }
  const policy = PROVIDER_ACTION_POLICY[profile.authentication.custody][action];
  if (!policy) {
    throw new TypeError("Provider action is not allowed for this profile.");
  }
  return policy;
}
