import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  bindWizardNavigation,
  readWizardSession,
} from "../src/ui/session.js";
import { formatAuthUpdatedAt } from "../src/ui/time.js";

test("credential timestamps are formatted in the user's local date and time", () => {
  assert.equal(
    formatAuthUpdatedAt("2026-07-28T01:11:01.000Z", {
      locale: "en-US",
      timeZone: "Asia/Manila",
    }),
    "Jul 28, 2026, 9:11:01 AM",
  );
  assert.equal(formatAuthUpdatedAt("not-a-date"), null);
});

test("wizard HTML has accessible landmarks, labels, and no inline scripts", async () => {
  const html = await readFile("src/ui/index.html", "utf8");

  assert.match(html, /<html lang="en">/);
  assert.ok(
    html.indexOf('src="/session-bootstrap.js"') <
      html.indexOf('src="/app.js"'),
  );
  assert.match(html, /<body data-current-step="1">/u);
  assert.match(html, /<title>Relmio \| n8n Setup<\/title>/u);
  assert.match(html, /class="brand-mark"[\s\S]*<span>Relmio<\/span>/u);
  assert.match(html, /class="theme-picker"/u);
  assert.match(html, /name="color-theme" value="system"/u);
  assert.match(html, /name="color-theme" value="light"/u);
  assert.match(html, /name="color-theme" value="dark"/u);
  assert.match(html, /class="theme-icon theme-icon-system"/u);
  assert.match(html, /class="theme-icon theme-icon-light"/u);
  assert.match(html, /class="theme-icon theme-icon-dark"/u);
  assert.match(html, /title="Use system appearance"/u);
  assert.match(
    html,
    /<nav class="steps" aria-label="Setup progress">[\s\S]*data-step-marker="1"[\s\S]*data-step-marker="5"/u,
  );
  assert.match(
    html,
    /<main id="main-content" class="shell" tabindex="-1" aria-busy="false">/u,
  );
  assert.match(
    html,
    /<aside class="rail" aria-label="Setup progress and safety">/u,
  );
  assert.match(
    html,
    /class="rail"[\s\S]*<h1 id="page-title">[\s\S]*aria-label="Setup progress"[\s\S]*class="toast-stack"[\s\S]*<section class="panel" data-step="1"/u,
  );
  assert.match(html, /unofficial, private, and policy-uncertain/u);
  assert.doesNotMatch(html, /class="(?:eyebrow|step-kicker)"/u);
  assert.doesNotMatch(html, /n8n OAuth Bridge/u);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /Back up first/);
  assert.match(html, /Export your n8n workflows before connecting/);
  assert.match(
    html,
    /class="toast-stack" aria-label="Wizard notifications"[\s\S]*id="global-safety"[\s\S]*id="global-backup"[\s\S]*id="global-message"[\s\S]*id="global-error"/u,
  );
  assert.match(html, /id="global-message"[\s\S]*role="status"/u);
  assert.match(html, /id="global-error"[\s\S]*role="alert"\s+tabindex="-1"/u);
  assert.equal(
    (html.match(/class="toast-close"/gu) ?? []).length,
    4,
  );
  assert.match(html, /data-dismiss-toast="global-safety"/u);
  assert.match(html, /data-dismiss-toast="global-backup"/u);
  assert.match(html, /data-dismiss-toast="global-message"/u);
  assert.match(html, /data-dismiss-toast="global-error"/u);
  assert.match(
    html,
    /id="auth-updated"[^>]*hidden[\s\S]*<time id="auth-updated-time"><\/time>/,
  );
  assert.equal(
    (html.match(/<h2[^>]*tabindex="-1"/g) ?? []).length,
    5,
  );
  assert.match(html, /<label class="field">[\s\S]*id="host"/);
  assert.match(html, /id="password"[\s\S]*disabled[\s\S]*required/);
  assert.match(
    html,
    /data-copy-target="result-url"[\s\S]*aria-label="Copy Base URL"/,
  );
  assert.match(
    html,
    /data-copy-target="result-key"[\s\S]*aria-label="Copy API key"/,
  );
  assert.match(
    html,
    /data-copy-target="result-model"[\s\S]*aria-label="Copy model ID"/,
  );
  assert.match(
    html,
    /data-copy-target="result-http-url"[\s\S]*aria-label="Copy HTTP endpoint"/,
  );
  assert.match(
    html,
    /data-copy-target="result-http-body"[\s\S]*aria-label="Copy HTTP JSON body"/,
  );
  assert.match(html, /id="copy-settings"[\s\S]*data-copy-group="credential"/u);
  assert.match(html, /id="copy-http-recipe"[\s\S]*data-copy-group="http"/u);
  assert.equal(
    (html.match(/<details class="recipe-disclosure">/gu) ?? []).length,
    2,
  );
  assert.match(
    html,
    /<details class="recipe-disclosure">[\s\S]*<summary>[\s\S]*AI Agent or Basic LLM Chain/u,
  );
  assert.match(
    html,
    /<details class="recipe-disclosure">[\s\S]*<summary>[\s\S]*HTTP Request node/u,
  );
  assert.match(html, /<dt>Method<\/dt>[\s\S]*<code>POST<\/code>/u);
  assert.match(html, /Generic Auth Type[\s\S]*Bearer Auth/u);
  assert.match(html, /Credential[\s\S]*openai-oauth/u);
  assert.match(html, /Bearer token[\s\S]*local-only/u);
  assert.match(html, /Authorization header[\s\S]*Bearer local-only/u);
  assert.match(
    html,
    /data-copy-target="result-http-auth"[\s\S]*aria-label="Copy Authorization header"/u,
  );
  assert.match(html, /Content-Type[\s\S]*application\/json/u);
  assert.match(html, /Send body[\s\S]*JSON[\s\S]*Using JSON/u);
  assert.match(html, /id="result-http-body"/u);
  assert.match(html, /OpenAI credential[\s\S]*OpenAI Chat Model/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\sonclick=/i);
});

test("every wizard route clears the browser transfer before loading its application module", async () => {
  for (const [path, applicationScript] of [
    ["src/ui/index.html", "/app.js"],
    ["src/ui/local.html", "/local.js"],
    ["src/ui/assistant.html", "/assistant.js"],
  ]) {
    const html = await readFile(path, "utf8");
    const bootstrapIndex = html.indexOf('src="/session-bootstrap.js"');
    assert.ok(bootstrapIndex >= 0, path);
    assert.ok(bootstrapIndex < html.indexOf(`src="${applicationScript}"`), path);
  }

  const session = await readFile("src/ui/session.js", "utf8");
  assert.match(session, /await pendingBrowserTransfer/u);
  assert.doesNotMatch(session, /location\.search[\s\S]*session/u);
});

test("VPS wizard uses icon-only copy controls and starts fresh from Ready", async () => {
  const [html, script, css] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/styles.css", "utf8"),
  ]);

  assert.doesNotMatch(html, />\s*Copy(?:\s+[^<]*)?\s*<\/button>/u);
  assert.match(
    html,
    /data-copy-target="result-url"[\s\S]*aria-label="Copy Base URL"[\s\S]*title="Copy Base URL"[\s\S]*class="copy-icon copy-icon-copy"[\s\S]*class="copy-icon copy-icon-check"/u,
  );
  assert.match(
    html,
    /id="copy-settings"[\s\S]*aria-label="Copy OpenAI credential settings"[\s\S]*title="Copy OpenAI credential settings"/u,
  );
  assert.match(html, /data-step="5"[\s\S]*id="setup-another-vps"/u);
  assert.doesNotMatch(html, /data-step="5"[\s\S]*data-back="4"/u);
  assert.match(
    script,
    /bindWizardNavigation\(element\("setup-another-vps"\), "\/", token\);/u,
  );
  assert.match(script, /button\.classList\.add\("copied"\)/u);
  assert.match(css, /\.copy-value\.copied \.copy-icon-copy/u);
  assert.match(css, /\.copy-value\.copied \.copy-icon-check/u);
  assert.match(css, /\.copy-value\s*\{[^}]*min-height:\s*2\.75rem;[^}]*width:\s*2\.75rem;/su);
});

test("detected VPS n8n exposes managed bridge and Assistant companion paths", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);

  assert.match(
    html,
    /id="detected-vps-integration-management"[^>]*hidden[\s\S]*Manage detected self-hosted n8n/u,
  );
  assert.match(html, /id="manage-vps-sidecar"[\s\S]*OpenAI-OAuth\/Codex bridge/u);
  assert.match(html, /id="manage-vps-assistant"[\s\S]*Assistant companion/u);
  assert.match(html, /id="refresh-vps-chatgpt"[^>]*>\s*Refresh ChatGPT sign-in\s*<\/button>/u);
  assert.match(
    html,
    /id="disconnect-vps-button"[^>]*>\s*Disconnect from VPS\s*<\/button>/u,
  );
  assert.match(html, /id="manage-vps-searxng" type="checkbox"/u);
  assert.match(script, /api\(assistant \? "\/api\/assistant\/plan" : "\/api\/plan"/u);
  assert.match(script, /api\(assistant \? "\/api\/assistant\/install" : "\/api\/install"/u);
  assert.match(script, /element\("login-button"\)\.click\(\)/u);
  assert.match(script, /element\("sidecar-ready-content"\)\.hidden = assistant/u);
  assert.doesNotMatch(script, /\.innerHTML\b/);
});

test("VPS disconnect clears only browser connection state after an exact server acknowledgement", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("async function disconnectVpsSession()");
  const end = script.indexOf(
    '\nelement("disconnect-vps-button")',
    start,
  );
  assert.ok(start >= 0 && end > start, "missing VPS disconnect boundary");
  const source = script.slice(start, end);
  const calls = [];
  const state = {
    discovery: { containers: [{}] },
    networks: { networks: ["n8n_default"] },
  };
  const elements = new Map([
    ["container-select", { replaceChildren: () => calls.push(["clear", "container-select"]) }],
    ["network-select", { replaceChildren: () => calls.push(["clear", "network-select"]) }],
    ["detected-vps-integration-management", { hidden: false }],
  ]);
  let response = { disconnected: true };
  const disconnectVpsSession = vm.runInNewContext(
    `${source}; disconnectVpsSession;`,
    {
      async api(path, options) {
        calls.push(["api", path, options]);
        return response;
      },
      element(id) {
        return elements.get(id);
      },
      invalidateReviewedPlan() {
        calls.push(["invalidate-plan"]);
      },
      resetFingerprint() {
        calls.push(["reset-fingerprint"]);
      },
      state,
    },
    { filename: "vps-disconnect.vm.js", timeout: 1_000 },
  );

  await disconnectVpsSession();
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0][1], "/api/disconnect");
  assert.equal(
    JSON.stringify(calls[0][2]),
    JSON.stringify({ method: "POST", body: {} }),
  );
  assert.equal(state.discovery, null);
  assert.equal(state.networks, null);
  assert.equal(elements.get("detected-vps-integration-management").hidden, true);
  assert.ok(calls.some(([name]) => name === "invalidate-plan"));
  assert.ok(calls.some(([name]) => name === "reset-fingerprint"));

  calls.length = 0;
  state.discovery = { containers: [{}] };
  state.networks = { networks: ["n8n_default"] };
  response = { disconnected: true, unexpected: "field" };
  await assert.rejects(disconnectVpsSession(), /unexpected disconnect response/u);
  assert.equal(state.discovery.containers.length, 1);
  assert.equal(state.networks.networks.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0][1], "/api/disconnect");
  assert.equal(
    JSON.stringify(calls[0][2]),
    JSON.stringify({ method: "POST", body: {} }),
  );
});

test("VPS integration review can be rendered repeatedly without deleting its summary fields", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);
  const reviewList = html.indexOf('<ul id="review-will-list"');
  assert.ok(reviewList > 0);
  assert.ok(html.indexOf('id="review-network"') < reviewList);
  assert.ok(html.indexOf('id="review-endpoint"') < reviewList);

  const functionStart = script.indexOf("function replaceReviewItems(");
  const functionEnd = script.indexOf("const ASSISTANT_SANDBOX_IMAGE", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);

  const elements = new Map(
    [
      "review-intro",
      "review-network",
      "review-endpoint-label",
      "review-endpoint",
      "review-will-list",
      "review-wont-list",
      "install-confirm-copy",
      "install-button",
    ].map((id) => [
      id,
      {
        children: [],
        dataset: {},
        textContent: "",
        replaceChildren(...children) {
          this.children = children;
        },
      },
    ]),
  );
  const context = {
    document: {
      createElement() {
        return { textContent: "" };
      },
      getElementById(id) {
        return elements.get(id) ?? null;
      },
    },
  };
  const review = vm.runInNewContext(
    `const state = { integrationKind: "sidecar", managingDetectedIntegration: false };
     const element = (id) => document.getElementById(id);
     ${script.slice(functionStart, functionEnd)}
     ({ state, renderIntegrationReview });`,
    context,
  );

  review.renderIntegrationReview({
    endpointHostname: "n8n-openai-oauth",
    networkName: "n8n_default",
  });
  review.state.integrationKind = "assistant";
  review.state.managingDetectedIntegration = true;
  review.renderIntegrationReview({ includeSearxng: true, networkName: "n8n_default" });
  review.state.integrationKind = "sidecar";
  review.renderIntegrationReview({
    endpointHostname: "n8n-openai-oauth",
    networkName: "n8n_default",
  });

  assert.equal(elements.get("review-network").textContent, "n8n_default");
  assert.equal(elements.get("review-endpoint-label").textContent, "Private hostname");
  assert.equal(elements.get("review-endpoint").textContent, "n8n-openai-oauth");
  assert.equal(elements.get("review-will-list").children.length, 4);
  assert.equal(elements.get("review-wont-list").children.length, 4);
  assert.equal(elements.get("install-button").textContent, "Update the bridge");
});

test("VPS Assistant results render validated one-time connection settings", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);

  assert.match(html, /id="assistant-result-sandbox-url"/u);
  assert.match(html, /id="assistant-result-sandbox-key"/u);
  assert.match(html, /Code Sandbox API key\s*<small>\(shown once\)<\/small>/u);
  assert.match(html, /id="assistant-result-searxng-row"[^>]*hidden/u);
  assert.match(html, /id="assistant-result-settings"/u);
  assert.match(html, /Relmio never edits its Compose file or restarts its container/u);
  assert.match(script, /function validateAssistantInstallResult\(result\)/u);
  assert.match(script, /function renderAssistantResult\(result\)/u);
  assert.match(script, /N8N_INSTANCE_AI_SANDBOX_IMAGE/u);
  assert.match(script, /N8N_SANDBOX_SERVICE_API_KEY/u);
  assert.match(script, /Object\.keys\(value\)\.length !== expectedNames\.length/u);
  assert.match(script, /!Object\.hasOwn\(value, name\)/u);
  assert.match(script, /value\[name\] !== expectedSettings\[name\]/u);
  assert.match(script, /result\.n8nSettings,\s*expectedSettings/u);
  assert.match(script, /intentionally does not return the existing sandbox API key/u);
  assert.match(script, /preserve[^\n]*N8N_ENABLED_MODULES[^\n]*instance-ai/iu);
  assert.doesNotMatch(script, /N8N_ENABLED_MODULES:\s*"instance-ai"/u);
  assert.doesNotMatch(script, /returnedSettings\s*\?\?/u);
  assert.match(script, /assistant-result-settings"\)\.textContent/u);
  assert.match(script, /assistant-result-key-row"\)\.hidden/u);
  assert.match(script, /sidecar-ready-content"\)\.hidden = assistant/u);
  assert.doesNotMatch(script, /\.innerHTML\b/);
});

test("VPS Assistant result validation executes before any result DOM mutation", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const functionStart = script.indexOf("const ASSISTANT_SANDBOX_IMAGE");
  const functionEnd = script.indexOf("async function loadNetworks", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);

  const elements = new Map(
    [
      "assistant-result-sandbox-url",
      "assistant-result-sandbox-key",
      "assistant-result-key-row",
      "assistant-result-searxng-row",
      "assistant-result-searxng-url",
      "assistant-result-settings",
      "assistant-result-key-note",
    ].map((id) => [id, { hidden: false, textContent: "unchanged" }]),
  );
  const assistantUi = vm.runInNewContext(
    `const element = (id) => document.getElementById(id);
     ${script.slice(functionStart, functionEnd)}
     ({ validateAssistantInstallResult, renderAssistantResult });`,
    {
      document: {
        getElementById(id) {
          return elements.get(id) ?? null;
        },
      },
    },
  );
  const sandboxUrl = `http://relmio-ai-sandbox-${"a".repeat(32)}:8080`;
  const searxngUrl = `http://relmio-ai-searxng-${"b".repeat(32)}:8080`;
  const sandboxImage =
    "ghcr.io/n8n-io/n8n-sandbox-service-sandbox:1.1.0@sha256:16f62fb90a4ce61ef74925f62ea76bb11eb2a5598888b7c0651100c7944ed2d8";
  const sandboxApiKey = "A".repeat(43);
  const settingsFor = ({ key, searchUrl } = {}) => ({
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: sandboxImage,
    N8N_SANDBOX_SERVICE_URL: sandboxUrl,
    ...(key ? { N8N_SANDBOX_SERVICE_API_KEY: key } : {}),
    ...(searchUrl ? { N8N_INSTANCE_AI_SEARXNG_URL: searchUrl } : {}),
  });

  const installed = assistantUi.renderAssistantResult({
    deploymentMode: "installed",
    includeSearxng: true,
    n8nSettings: settingsFor({ key: sandboxApiKey, searchUrl: searxngUrl }),
    sandboxApiKey,
    sandboxUrl,
    searxngUrl,
  });
  assert.equal(installed.includeSearxng, true);
  assert.equal(elements.get("assistant-result-key-row").hidden, false);
  assert.equal(elements.get("assistant-result-searxng-row").hidden, false);
  assert.equal(elements.get("assistant-result-sandbox-key").textContent, sandboxApiKey);
  assert.match(elements.get("assistant-result-key-note").textContent, /shown-once API key/u);

  assistantUi.renderAssistantResult({
    deploymentMode: "updated",
    includeSearxng: false,
    n8nSettings: settingsFor(),
    sandboxApiKey: null,
    sandboxUrl,
  });
  assert.equal(elements.get("assistant-result-key-row").hidden, true);
  assert.equal(elements.get("assistant-result-searxng-row").hidden, true);
  assert.equal(elements.get("assistant-result-sandbox-key").textContent, "");
  assert.match(
    elements.get("assistant-result-key-note").textContent,
    /does not return the existing sandbox API key[\s\S]*Preserve the existing N8N_ENABLED_MODULES/u,
  );

  const beforeInvalid = [...elements].map(([id, value]) => [
    id,
    { hidden: value.hidden, textContent: value.textContent },
  ]);
  assert.throws(
    () =>
      assistantUi.renderAssistantResult({
        deploymentMode: "updated",
        includeSearxng: false,
        n8nSettings: { ...settingsFor(), UNREVIEWED_SETTING: "unsafe" },
        sandboxApiKey: null,
        sandboxUrl,
      }),
    /invalid n8n settings/u,
  );
  assert.deepEqual(
    [...elements].map(([id, value]) => [
      id,
      { hidden: value.hidden, textContent: value.textContent },
    ]),
    beforeInvalid,
  );
  assert.throws(
    () =>
      assistantUi.validateAssistantInstallResult({
        deploymentMode: "installed",
        includeSearxng: false,
        n8nSettings: settingsFor({ key: "short" }),
        sandboxApiKey: "short",
        sandboxUrl,
      }),
    /invalid Assistant result/u,
  );
  assert.throws(
    () =>
      assistantUi.validateAssistantInstallResult({
        deploymentMode: "updated",
        includeSearxng: false,
        n8nSettings: settingsFor(),
        sandboxApiKey: null,
        sandboxUrl: "https://example.test/sandbox",
      }),
    /invalid Code Sandbox URL/u,
  );
});

test("workspace CSS keeps the document still and notices in flow", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");

  const bodyBlock = css.match(/(?:^|\n)body\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(bodyBlock, /overflow:\s*hidden/u);

  const toastStackBlock = css.match(/\.toast-stack\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.notEqual(toastStackBlock, "");
  assert.doesNotMatch(toastStackBlock, /position:\s*fixed/u);

  const panelBlock = css.match(/\.panel\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(panelBlock, /overflow-y:\s*auto/u);

  assert.match(css, /--radius-lg:\s*1rem/u);
});

test("short narrow viewports preserve an internally scrollable task panel", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");
  const shortNarrowStart = css.indexOf(
    "@media (max-width: 60rem) and (max-height: 36rem)",
  );

  assert.notEqual(shortNarrowStart, -1);

  const shortNarrowCss = css.slice(shortNarrowStart);
  assert.match(shortNarrowCss, /\.intro\s*\{\s*display:\s*none/u);
  assert.match(
    shortNarrowCss,
    /\.shell\s*\{[\s\S]*grid-template-rows:\s*auto\s+minmax\(7rem,\s*1fr\)/u,
  );
  assert.match(
    shortNarrowCss,
    /\.toast-stack\s*\{[\s\S]*display:\s*flex[\s\S]*overflow-x:\s*auto/u,
  );
  assert.match(shortNarrowCss, /\.safety-note\s*>\s*span\s*\{\s*display:\s*none/u);
  assert.match(
    shortNarrowCss,
    /\.panel\s*\{[\s\S]*min-height:\s*7rem[\s\S]*overflow-y:\s*auto/u,
  );
});

test("browser code never uses innerHTML or web storage for credentials", async () => {
  const [app, oauthPopup] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/oauth-popup.js", "utf8"),
  ]);
  const browserCode = `${app}\n${oauthPopup}`;

  assert.doesNotMatch(browserCode, /\.innerHTML\b/);
  assert.doesNotMatch(browserCode, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(app, /console\.(?:log|warn|error)/);
  assert.match(app, /textContent/);
  assert.match(app, /authUpdatedAt/);
  assert.match(app, /Fresh sign-in saved/);
  assert.match(app, /unexpected response/);
  assert.match(app, /For a persistent install, run relmio open/);
  assert.match(app, /npx --yes --ignore-scripts relmio@latest open/);
  assert.match(
    app,
    /For a hosted foreground launcher, return to the active terminal and press Enter to create a fresh private handoff/,
  );
  assert.doesNotMatch(app, /URL printed by its active terminal/u);
  assert.match(app, /installAttempted/);
  assert.match(app, /status\.previewMode/);
  assert.match(app, /Preview sign-in disabled/);
  assert.match(
    app,
    /querySelectorAll\(\s*"\[data-copy-target\], \[data-copy-group\]",?\s*\)/u,
  );
  assert.match(app, /async function copyText\(value\)/);
  assert.match(app, /textarea\.focus\(\)/);
  assert.match(app, /textarea\.select\(\)/);
  assert.match(app, /textarea\.setSelectionRange\?\.\(0, textarea\.value\.length\)/);
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(
    app,
    /const textarea = document\.createElement\("textarea"\);[\s\S]*textarea\.focus\(\);[\s\S]*textarea\.select\(\);[\s\S]*textarea\.setSelectionRange\?\.\(0, textarea\.value\.length\);[\s\S]*document\.execCommand\("copy"\)[\s\S]*finally \{[\s\S]*textarea\.remove\(\);[\s\S]*previouslyFocused\?\.focus\?\.\(\);[\s\S]*if \(copied\) \{[\s\S]*navigator\.clipboard\.writeText\(value\)/u,
  );
  assert.match(app, /messages:[\s\S]*What is a robot\?/u);
  assert.match(app, /response_format:[\s\S]*json_schema/u);
  assert.match(app, /additionalProperties: false/u);
  assert.match(app, /strict: true/u);
  assert.match(app, /chat\/completions/u);
  assert.match(app, /Authentication: Generic Credential Type/u);
  assert.match(app, /Generic Auth Type: Bearer Auth/u);
  assert.match(app, /Authorization: \$\{element\("result-http-auth"\)\.textContent\}/u);
  assert.match(app, /Specify Body: Using JSON/u);
  assert.match(app, /function dismissToast\(toast\)/u);
  assert.match(app, /document\.body\.dataset\.currentStep = String\(step\)/u);
  assert.match(
    app,
    /if \(step === 5\) \{[\s\S]*dismissToast\(element\("global-safety"\)\);[\s\S]*dismissToast\(element\("global-backup"\)\);/u,
  );
  assert.match(app, /window\.setTimeout\([\s\S]*dismissToast\(messageToast\)/u);
  assert.match(app, /data-dismiss-toast/u);
  assert.doesNotMatch(app, /"Use Responses API: on"/u);
});

test("wizard session rejects query capabilities and reads only clean-entry history state", () => {
  const sessionToken = "A".repeat(43);
  const replacements = [];
  const browserWindow = {
    history: {
      state: { relmioWizardSession: "B".repeat(43), unrelated: true },
      replaceState(nextState, title, pathname) {
        this.state = nextState;
        replacements.push({ nextState, title, pathname });
      },
    },
    location: {
      hash: "#dashboard-overview",
      pathname: "/local",
      search: `?session=${sessionToken}`,
    },
  };

  assert.equal(readWizardSession(browserWindow), "B".repeat(43));
  assert.deepEqual(browserWindow.history.state, {
    relmioWizardSession: "B".repeat(43),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replacements.at(-1))), {
    nextState: { relmioWizardSession: "B".repeat(43) },
    title: "",
    pathname: "/local#dashboard-overview",
  });
});

test("wizard session rejects malformed query capabilities and sanitizes history state", () => {
  const sessionToken = "C".repeat(43);

  for (const search of [
    `?session=${sessionToken}&extra=1`,
    `?extra=1&session=${sessionToken}`,
    `?session=${sessionToken.slice(0, 42)}`,
    `?session=${sessionToken}%20`,
    `?session=${"!".repeat(43)}`,
  ]) {
    const browserWindow = {
      history: {
        state: null,
        replaceState(nextState, title, pathname) {
          this.state = nextState;
          assert.equal(title, "");
          assert.equal(pathname, "/assistant");
        },
      },
      location: { hash: "", pathname: "/assistant", search },
    };

    assert.equal(readWizardSession(browserWindow), null, search);
    assert.equal(browserWindow.history.state, null, search);
  }

  const browserWindow = {
    history: {
      state: { relmioWizardSession: sessionToken, unrelated: true },
      replaceState(nextState) {
        this.state = nextState;
      },
    },
    location: { hash: "", pathname: "/", search: "" },
  };
  assert.equal(readWizardSession(browserWindow), sessionToken);
  assert.deepEqual(browserWindow.history.state, {
    relmioWizardSession: sessionToken,
  });

  browserWindow.history.state = { relmioWizardSession: 42 };
  assert.equal(readWizardSession(browserWindow), null);
  assert.equal(browserWindow.history.state, null);
});

test("fragment navigation preserves the session across reload and back-forward entries", () => {
  const sessionToken = "H".repeat(43);
  const listeners = new Map();
  const browserWindow = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    history: {
      state: { relmioWizardSession: sessionToken },
      replaceState(nextState, title, path) {
        this.state = nextState;
        this.lastReplacement = { nextState, title, path };
      },
    },
    location: { hash: "", pathname: "/local", search: "" },
  };

  assert.equal(readWizardSession(browserWindow), sessionToken);
  assert.equal(typeof listeners.get("hashchange"), "function");

  browserWindow.location.hash = "#dashboard-activity";
  browserWindow.history.state = null;
  listeners.get("hashchange")();
  assert.deepEqual(browserWindow.history.state, {
    relmioWizardSession: sessionToken,
  });
  assert.equal(
    readWizardSession({
      history: browserWindow.history,
      location: browserWindow.location,
    }),
    sessionToken,
  );

  browserWindow.location.hash = "";
  browserWindow.history.state = null;
  listeners.get("hashchange")();
  assert.deepEqual(browserWindow.history.lastReplacement, {
    nextState: { relmioWizardSession: sessionToken },
    title: "",
    path: "/local",
  });
});

test("browser transfer bootstrap clears window.name before exchange and stores only the returned session", async () => {
  const script = await readFile("src/ui/session-bootstrap.js", "utf8");
  const transferId = "T".repeat(43);
  const secret = "S".repeat(43);
  const sessionToken = "W".repeat(43);
  const calls = [];
  const replacements = [];
  let resolveTransfer;
  const browserWindow = {
    name: `relmio-v1.${transferId}.${secret}`,
    location: { hash: "", pathname: "/local", search: "" },
    history: {
      replaceState(nextState, title, path) {
        replacements.push({ nextState, title, path });
      },
    },
  };
  browserWindow.window = browserWindow;
  const context = vm.createContext({
    window: browserWindow,
    fetch: (...args) => {
      assert.equal(browserWindow.name, "");
      calls.push(args);
      return new Promise((resolve) => { resolveTransfer = resolve; });
    },
    JSON,
    Promise,
  });

  vm.runInContext(script, context);
  assert.equal(browserWindow.name, "");
  assert.equal(calls.length, 1);
  browserWindow.location.hash = "#dashboard";
  browserWindow.history.state = null;
  resolveTransfer({
    ok: true,
    async json() { return { sessionToken }; },
  });
  await browserWindow.__relmioWizardSessionReady;
  assert.equal(calls[0][0], "/__relmio/browser/transfer");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    route: "/local",
    transferId,
    secret,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replacements.at(-1))), {
    nextState: { relmioWizardSession: sessionToken },
    title: "",
    path: "/local#dashboard",
  });
});

test("browser transfer bootstrap clears malformed window.name without making a request", async () => {
  const script = await readFile("src/ui/session-bootstrap.js", "utf8");
  for (const name of ["", "other", `relmio-v1.${"A".repeat(43)}.short`]) {
    let requests = 0;
    const browserWindow = {
      name,
      location: { hash: "", pathname: "/local", search: "" },
      history: { replaceState() {} },
    };
    browserWindow.window = browserWindow;
    vm.runInContext(script, vm.createContext({
      window: browserWindow,
      fetch: async () => { requests += 1; },
      JSON,
      Promise,
    }));
    assert.equal(browserWindow.name, "");
    await browserWindow.__relmioWizardSessionReady;
    assert.equal(requests, 0);
  }
});

test("wizard navigation keeps the capability in same-tab history and all link URLs token-free", () => {
  const sessionToken = "D".repeat(43);
  const listeners = new Map();
  const attributes = new Map();
  const link = {
    target: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
  const pushed = [];
  let reloads = 0;
  const browserWindow = {
    history: {
      pushState(nextState, title, pathname) {
        pushed.push({ nextState, title, pathname });
      },
    },
    location: {
      reload() {
        reloads += 1;
      },
    },
  };

  bindWizardNavigation(link, "/local", sessionToken, browserWindow);
  assert.equal(link.getAttribute("href"), "/local");
  assert.doesNotMatch(link.getAttribute("href"), /session|[?]/u);

  let prevented = false;
  listeners.get("click")({
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    preventDefault() {
      prevented = true;
    },
    shiftKey: false,
  });
  assert.equal(prevented, true);
  assert.deepEqual(pushed, [{
    nextState: { relmioWizardSession: sessionToken },
    title: "",
    pathname: "/local",
  }]);
  assert.equal(reloads, 1);

  for (const override of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    prevented = false;
    listeners.get("click")({
      altKey: false,
      button: 0,
      ctrlKey: false,
      defaultPrevented: false,
      metaKey: false,
      preventDefault() {
        prevented = true;
      },
      shiftKey: false,
      ...override,
    });
    assert.equal(prevented, false);
  }
  link.target = "_blank";
  listeners.get("click")({
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    preventDefault() {
      prevented = true;
    },
    shiftKey: false,
  });
  assert.equal(pushed.length, 1);
  assert.equal(reloads, 1);
});

test("persistent VPS and Assistant routes use the shared token-free session helpers", async () => {
  const routes = [
    { path: "/", scriptPath: "src/ui/app.js" },
    { path: "/assistant", scriptPath: "src/ui/assistant.js" },
  ];

  for (const route of routes) {
    const script = await readFile(route.scriptPath, "utf8");
    assert.match(
      script,
      /import \{ bindWizardNavigation, readWizardSession \} from "\.\/session\.js";/u,
    );
    assert.match(script, /const token = readWizardSession\(\);/u);
    assert.doesNotMatch(script, /[?]session=/u);
    assert.doesNotMatch(
      script,
      /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/u,
    );
  }

  const sessionHelper = await readFile("src/ui/session.js", "utf8");
  assert.doesNotMatch(
    sessionHelper,
    /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/u,
  );
});

test("VPS reload rehydrates and completes the server-owned pending OAuth attempt", async () => {
  const app = await readFile("src/ui/app.js", "utf8");
  const start = app.indexOf("async function recoverPendingOAuthAttempt()");
  const end = app.indexOf("\nasync function initializeVpsWizard()", start);
  assert.ok(start >= 0 && end > start, "missing OAuth reload recovery boundary");
  assert.match(
    app,
    /async function initializeVpsWizard\(\) \{[\s\S]*recoverPendingOAuthAttempt\(\)[\s\S]*if \(!recoveredOAuth\) \{[\s\S]*refreshAuthStatus\(\);[\s\S]*initializeVpsWizard\(\)\.catch\(showError\);/u,
  );
  const source = app.slice(start, end);
  const calls = [];
  const state = {
    oauthAttemptId: null,
    oauthCancellationMessage: "",
    oauthLoginGeneration: 4,
    oauthLoginWindow: null,
    oauthRetryBlocked: false,
  };
  const loginLink = {
    hidden: false,
    removeAttribute(name) {
      calls.push(["remove-attribute", name]);
    },
  };
  const context = {
    state,
    async api(path) {
      calls.push(["api", path]);
      if (path === "/api/oauth/status") {
        return { attemptId: "a1b2c3d4-1234", status: "pending" };
      }
      if (path === "/api/status") {
        return { authExists: true, authUpdatedAt: "2026-09-04T00:00:00.000Z" };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    blockOAuthRetry() {
      calls.push(["block-retry"]);
    },
    element(id) {
      assert.equal(id, "login-link");
      return loginLink;
    },
    renderAuthStatus(status, options) {
      calls.push(["render-auth", status.authExists, options.fresh]);
    },
    async runOperation(trigger, label, work, options) {
      calls.push(["operation", trigger, label, options.allowedSelector]);
      return work();
    },
    setMessage(message) {
      calls.push(["message", message]);
    },
    setOAuthStopControlVisible(visible) {
      calls.push(["stop-visible", visible]);
    },
    updateOperationLabel(label) {
      calls.push(["operation-label", label]);
    },
    showError(error) {
      calls.push(["error", error.message]);
    },
    validateOAuthAttemptId(value) {
      calls.push(["validate-attempt", value]);
      return value;
    },
    async waitForOAuthCompletion(attemptId) {
      calls.push(["wait", attemptId]);
    },
    OPERATION_ALLOWED_SELECTOR: "#login-link, #stop-login-button",
  };
  const recoverPendingOAuthAttempt = vm.runInNewContext(
    `${source}; recoverPendingOAuthAttempt`,
    context,
    { filename: "vps-oauth-reload-recovery.vm.js", timeout: 1_000 },
  );

  assert.equal(await recoverPendingOAuthAttempt(), true);
  assert.equal(state.oauthLoginGeneration, 5);
  assert.equal(state.oauthAttemptId, null);
  assert.equal(loginLink.hidden, true);
  assert.deepEqual(calls, [
    [
      "operation",
      null,
      "Checking for active ChatGPT sign-in…",
      "#login-link, #stop-login-button",
    ],
    ["api", "/api/oauth/status"],
    ["validate-attempt", "a1b2c3d4-1234"],
    ["remove-attribute", "href"],
    ["stop-visible", true],
    [
      "message",
      "A ChatGPT sign-in is still in progress. Complete it in its existing browser tab, or stop it here.",
    ],
    ["operation-label", "Reconnecting to ChatGPT sign-in…"],
    ["wait", "a1b2c3d4-1234"],
    ["api", "/api/status"],
    ["render-auth", true, true],
    ["stop-visible", false],
  ]);
  assert.doesNotMatch(
    JSON.stringify(state),
    /authorizationUrl|credential|password/iu,
  );
});

test("copy success survives the browser clearing event.currentTarget", async () => {
  const app = await readFile("src/ui/app.js", "utf8");
  const functionStart = app.indexOf("function createCopyClickHandler(");
  const functionEnd = app.indexOf("const handleCopyClick", functionStart);

  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const functionSource = app.slice(functionStart, functionEnd).trimEnd();
  const createCopyClickHandler = vm.runInNewContext(
    `${functionSource}; createCopyClickHandler`,
  );
  const button = { dataset: { copyLabel: "Base URL" } };
  const event = { currentTarget: button };
  const calls = [];
  const handler = createCopyClickHandler({
    copyValueFor(copyButton) {
      assert.equal(copyButton, button);
      return "http://n8n-openai-oauth:10531/v1";
    },
    clearError() {
      calls.push("clear-error");
    },
    async copyText(value) {
      calls.push(["copy", value]);
      await Promise.resolve();
    },
    flashCopied(copyButton) {
      calls.push(["flash", copyButton]);
    },
    setMessage(message) {
      calls.push(["message", message]);
    },
    showError(error) {
      calls.push(["error", error.message]);
    },
  });

  const completion = handler(event);
  event.currentTarget = null;
  await completion;

  assert.deepEqual(calls, [
    "clear-error",
    ["copy", "http://n8n-openai-oauth:10531/v1"],
    ["flash", button],
    ["message", "Base URL copied."],
  ]);
});

test("local OAuth prepares and navigates its popup before severing opener access", async () => {
  const [app, html] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/index.html", "utf8"),
  ]);

  assert.match(app, /Preparing a fresh ChatGPT sign-in/u);
  assert.match(app, /prepareOAuthPopup\(loginWindow\);/u);
  assert.match(
    app,
    /loginWindow\.location\.replace\(authorizationUrl\);[\s\S]*loginWindowNavigated = true;[\s\S]*loginWindow\.opener = null;/u,
  );
  assert.match(
    app,
    /loginWindow\.location\.replace\(authorizationUrl\);[\s\S]*loginWindow\.opener = null;/u,
  );
  assert.doesNotMatch(
    app,
    /const loginWindow = window\.open\("about:blank", "_blank"\);[\s\S]{0,120}loginWindow\.opener = null;/u,
  );
  assert.match(app, /loginLink\.href = authorizationUrl;/u);
  assert.match(app, /loginWindow\.close\(\);/u);
  assert.match(html, /id="login-link"[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"/u);
});

test("OAuth UI offers an accessible stop control and rejects stale polling after replacement", async () => {
  const [app, html] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/index.html", "utf8"),
  ]);

  assert.match(
    html,
    /<button id="stop-login-button" class="button secondary" type="button" hidden>\s*Stop ChatGPT sign-in\s*<\/button>/u,
  );
  assert.match(app, /async function waitForOAuthCompletion\(expectedAttemptId\)/u);
  assert.match(
    app,
    /result\.retryBlocked === true[\s\S]*oauthRetryBlocked = true[\s\S]*result\.attemptId !== expectedAttemptId/u,
  );
  assert.match(
    app,
    /result\.attemptId !== expectedAttemptId[\s\S]*replaced by a newer attempt/u,
  );
  assert.match(
    app,
    /if \(error\.oauthRetryBlocked === true\) \{\s*blockOAuthRetry\(\);/u,
  );
  assert.match(app, /\/api\/oauth\/cancel/u);
  assert.match(app, /body: \{ attemptId \}/u);
  assert.match(app, /oauthLoginGeneration/u);
  assert.match(app, /oauthRetryBlocked/u);
  assert.match(app, /stop-login-button/u);
});

test("wizard theme preferences store only the selected color mode", async () => {
  const theme = await readFile("src/ui/theme.js", "utf8");

  assert.match(theme, /relmio-color-mode/u);
  assert.match(theme, /localStorage\.getItem/u);
  assert.match(theme, /localStorage\.setItem/u);
  assert.doesNotMatch(theme, /password|credential|token|fingerprint/iu);
});
