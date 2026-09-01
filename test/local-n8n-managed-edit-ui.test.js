import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source end marker: ${endMarker}`);
  return source.slice(start, end);
}

function createElement({ checked = false, disabled = false, textContent = "" } = {}) {
  const handlers = new Map();
  return {
    checked,
    dataset: {},
    disabled,
    handlers,
    hidden: false,
    textContent,
    addEventListener(name, handler) {
      handlers.set(name, handler);
    },
  };
}

function createHarness() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  for (const id of [
    "refresh-bridge-confirm",
    "refresh-bridge-button",
    "refresh-bridge-status",
    "review-assistant-searxng-edit",
    "assistant-searxng-edit-sandbox",
    "assistant-searxng-edit-search",
    "assistant-searxng-edit-review",
    "enable-assistant-searxng-confirm",
    "enable-assistant-searxng-button",
    "assistant-searxng-edit-result",
    "assistant-searxng-edit-settings",
    "assistant-searxng-edit-status",
  ]) {
    elements.set(id, createElement());
  }
  return {
    apiCalls: [],
    element,
    errors: [],
    messages: [],
    state: {
      n8nOAuthExists: true,
      assistantSearxngReviewId: null,
      assistantSearxngReview: null,
    },
  };
}

function loadHandlers(script, harness, api) {
  const validators = extractBetween(
    script,
    "function hasExactKeys(value, expectedNames)",
    "\nasync function refreshN8nOAuthStatus",
  );
  const handlers = extractBetween(
    script,
    'element("refresh-bridge-confirm").addEventListener("change"',
    '\nelement("install-confirm").addEventListener("change"',
  );
  return runInNewContext(
    `${validators}\n${handlers}\n({
      bridgeConfirm: element("refresh-bridge-confirm").handlers.get("change"),
      bridgeRefresh: element("refresh-bridge-button").handlers.get("click"),
      assistantReview: element("review-assistant-searxng-edit").handlers.get("click"),
      assistantConfirm: element("enable-assistant-searxng-confirm").handlers.get("change"),
      assistantEnable: element("enable-assistant-searxng-button").handlers.get("click"),
    })`,
    {
      api: async (path, options) => {
        harness.apiCalls.push({ path, options });
        return await api(path, options);
      },
      clearError() {},
      element: harness.element,
      setBusy() {},
      setMessage(message) {
        harness.messages.push(message);
      },
      showError(error) {
        harness.errors.push(error);
      },
      state: harness.state,
    },
    { filename: "local-n8n-managed-edit-ui.vm.js", timeout: 1_000 },
  );
}

const sandboxSuffix = "a".repeat(32);
const searchSuffix = "b".repeat(32);
const reviewId = "11111111-1111-4111-8111-111111111111";
const safeReview = {
  reviewId,
  target: "n8n-ai-assistant",
  includeSearxng: true,
  sandboxApiKeyRotated: false,
  sandboxUrl: `http://relmio-ai-sandbox-${sandboxSuffix}:8080`,
  searxngUrl: `http://relmio-ai-searxng-${searchSuffix}:8080`,
  n8nContainerName: "relmio-test-n8n",
  networkName: "relmio-test_assistant-shared",
  hostPublication: "none",
  n8nConfigurationRequired: true,
};

const safeAssistantEnablement = {
  target: "n8n-ai-assistant",
  endpoint: safeReview.sandboxUrl,
  sandboxUrl: safeReview.sandboxUrl,
  searxngUrl: safeReview.searxngUrl,
  protocol: "n8n-instance-ai-companion",
  includeSearxng: true,
  networkName: safeReview.networkName,
  n8nContainerName: safeReview.n8nContainerName,
  hostPublication: "none",
  privilegedRunner: true,
  n8nConfigurationRequired: true,
  n8nSettings: {
    N8N_INSTANCE_AI_SEARXNG_URL: safeReview.searxngUrl,
  },
  deploymentMode: "searxng-enabled",
  sandboxApiKeyRotated: false,
};

test("the real managed bridge control never applies sign-in without confirmation and sends no credential material", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createHarness();
  const controls = loadHandlers(script, harness, async (path) => {
    assert.equal(path, "/api/local/n8n/sidecar/refresh");
    return {
      target: "n8n-openai-oauth",
      credentialRefreshed: true,
      models: ["gpt-5.6-sol"],
      hostPublication: "none",
    };
  });
  const confirmation = harness.element("refresh-bridge-confirm");
  const button = harness.element("refresh-bridge-button");

  await controls.bridgeRefresh({ currentTarget: button });
  assert.equal(harness.apiCalls.length, 0);
  assert.match(harness.errors.at(-1).message, /sign-in and confirm/iu);

  confirmation.checked = true;
  controls.bridgeConfirm({ currentTarget: confirmation });
  assert.equal(button.disabled, false);
  await controls.bridgeRefresh({ currentTarget: button });
  assert.equal(harness.apiCalls.length, 1);
  assert.equal(harness.apiCalls[0].path, "/api/local/n8n/sidecar/refresh");
  assert.equal(harness.apiCalls[0].options.method, "POST");
  assert.equal(harness.apiCalls[0].options.body.confirmed, true);
  assert.deepEqual(Object.keys(harness.apiCalls[0].options.body), ["confirmed"]);
  assert.match(harness.element("refresh-bridge-status").textContent, /n8n was not changed/iu);
  assert.doesNotMatch(
    harness.element("refresh-bridge-status").textContent,
    /token|authPath|secret/iu,
  );
});

test("the real managed Assistant edit requires review plus confirmation and fails closed on secret-bearing output", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  let unexpected = false;
  const harness = createHarness();
  const controls = loadHandlers(script, harness, async (path, options) => {
    if (path.endsWith("/review")) {
      assert.equal(options.method, "POST");
      assert.equal(options.body.includeSearxng, true);
      assert.deepEqual(Object.keys(options.body), ["includeSearxng"]);
      return safeReview;
    }
    assert.equal(path, "/api/local/n8n/assistant/searxng/enable");
    assert.equal(options.method, "POST");
    assert.equal(options.body.reviewId, reviewId);
    assert.equal(options.body.confirmed, true);
    assert.deepEqual(Object.keys(options.body).sort(), ["confirmed", "reviewId"]);
    return unexpected
      ? { ...safeAssistantEnablement, sandboxApiKey: "must-not-reach-dom" }
      : safeAssistantEnablement;
  });
  const reviewButton = harness.element("review-assistant-searxng-edit");
  const confirmation = harness.element("enable-assistant-searxng-confirm");
  const enableButton = harness.element("enable-assistant-searxng-button");

  await controls.assistantEnable({ currentTarget: enableButton });
  assert.equal(harness.apiCalls.length, 0);
  assert.match(harness.errors.at(-1).message, /review and confirm/iu);

  await controls.assistantReview({ currentTarget: reviewButton });
  assert.equal(
    harness.state.assistantSearxngReviewId,
    reviewId,
    harness.errors.map((error) => error.message).join("; "),
  );
  assert.equal(harness.element("assistant-searxng-edit-review").hidden, false);
  assert.equal(harness.element("assistant-searxng-edit-sandbox").textContent, safeReview.sandboxUrl);
  confirmation.checked = true;
  controls.assistantConfirm({ currentTarget: confirmation });
  assert.equal(enableButton.disabled, false);
  await controls.assistantEnable({ currentTarget: enableButton });
  assert.equal(harness.state.assistantSearxngReviewId, null);
  assert.match(harness.element("assistant-searxng-edit-result").textContent, /not rotated or shown/iu);
  assert.match(harness.element("assistant-searxng-edit-settings").textContent, /N8N_INSTANCE_AI_SEARXNG_URL/u);
  assert.doesNotMatch(harness.element("assistant-searxng-edit-settings").textContent, /must-not-reach-dom|sandbox API key/i);

  unexpected = true;
  await controls.assistantReview({ currentTarget: reviewButton });
  confirmation.checked = true;
  controls.assistantConfirm({ currentTarget: confirmation });
  await controls.assistantEnable({ currentTarget: enableButton });
  assert.match(harness.errors.at(-1).message, /unexpected Assistant SearXNG response/iu);
  assert.doesNotMatch(
    harness.element("assistant-searxng-edit-settings").textContent,
    /must-not-reach-dom/u,
  );
});
