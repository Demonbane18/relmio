import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function localDashboardSources() {
  const [html, css, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.css", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);
  return { html, css, script };
}

function loadDashboardNormalizer(script) {
  const constantsStart = script.indexOf("const DASHBOARD_STATES");
  const constantsEnd = script.indexOf("\nconst messageBox", constantsStart);
  const contractStart = script.indexOf("function dashboardContractError");
  const contractEnd = script.indexOf("\nfunction parseRelmioStreamEvent", contractStart);
  assert.ok(constantsStart >= 0, "missing dashboard constants marker");
  assert.ok(constantsEnd > constantsStart, "missing dashboard constants end marker");
  assert.ok(contractStart >= 0, "missing dashboard contract marker");
  assert.ok(contractEnd > contractStart, "missing dashboard contract end marker");
  const hasExactKeys = `
    function hasExactKeys(value, expectedNames) {
      return value && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === expectedNames.length &&
        expectedNames.every((name) => Object.hasOwn(value, name));
    }
  `;
  return runInNewContext(
    `${hasExactKeys}\n${script.slice(constantsStart, constantsEnd)}\n${script.slice(contractStart, contractEnd)}\nnormalizeDashboardSnapshot;`,
    { URL },
    { filename: "local-dashboard-contract.vm.js", timeout: 1_000 },
  );
}

function sourceBetween(script, startMarker, endMarker) {
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker: ${endMarker}`);
  return script.slice(start, end);
}

function cssRuleDeclarations(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "u"));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

function validDashboardSnapshot() {
  const absent = (target, label, kind) => ({
    target,
    label,
    kind,
    managed: false,
    state: "absent",
    snapshot: null,
    actions: ["setup"],
  });
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-04T00:00:00.000Z",
    docker: { available: true, version: "28.3.3", composeVersion: "2.39.1" },
    auth: { secretsRevealable: false },
    services: [
      {
        target: "openai-api",
        label: "OpenAI API",
        kind: "endpoint",
        managed: true,
        state: "healthy",
        snapshot: {
          target: "openai-api",
          endpoint: "http://127.0.0.1:12435/v1",
          auth: { configured: true, disclosure: "rotate-only" },
          canRotateCredential: true,
        },
        actions: ["rotate-credential"],
      },
      absent("codex-chatgpt", "Codex (ChatGPT login)", "endpoint"),
      absent("codex-chat", "Codex Chat adapter", "endpoint"),
      {
        target: "local-n8n-stack",
        label: "n8n + ngrok",
        kind: "n8n-stack",
        managed: true,
        state: "partial",
        snapshot: null,
        actions: [],
      },
      {
        target: "n8n-openai-oauth",
        label: "OpenAI OAuth bridge",
        kind: "n8n-oauth-bridge",
        managed: true,
        state: "healthy",
        snapshot: {
          target: "n8n-openai-oauth",
          endpoint: "http://n8n-openai-oauth:10531/v1",
          auth: { configured: true, disclosure: "server-managed" },
          canRefreshCredential: true,
          canRemove: true,
        },
        actions: ["refresh-credential", "remove"],
      },
      {
        target: "local-n8n-assistant",
        label: "AI Assistant tools",
        kind: "n8n-assistant",
        managed: true,
        state: "healthy",
        snapshot: {
          target: "local-n8n-assistant",
          components: { codeSandbox: true, searxng: false },
          auth: { sandboxConfigured: true, disclosure: "one-time" },
          canRemove: true,
        },
        actions: ["remove"],
      },
    ],
  };
}

test("local route lands on an accessible persistent dashboard and keeps setup separate", async () => {
  const { html, script } = await localDashboardSources();

  assert.match(html, /<body[^>]*data-local-view="dashboard"/u);
  assert.match(
    html,
    /<section id="local-dashboard"[^>]*aria-labelledby="dashboard-title"/u,
  );
  assert.match(
    html,
    /<nav id="local-dashboard-nav"[^>]*aria-label="Local dashboard"/u,
  );
  assert.match(
    html,
    /href="#dashboard-overview"[^>]*aria-current="location"/u,
  );
  for (const destination of [
    "dashboard-overview",
    "dashboard-connections",
    "dashboard-n8n",
    "dashboard-credentials",
    "dashboard-activity",
  ]) {
    assert.match(html, new RegExp(`href="#${destination}"`, "u"));
  }
  assert.match(
    html,
    /id="dashboard-new-setup"[^>]*type="button"[^>]*>\s*(?:Add connection|New setup)/u,
  );
  assert.match(html, /id="local-setup"[^>]*hidden/u);
  assert.match(
    html,
    /id="local-setup"[\s\S]*<h1 id="page-title">Connect local apps or n8n<\/h1>/u,
  );
  assert.match(
    html,
    /id="local-setup"[\s\S]*<nav class="steps" aria-label="Local setup progress">[\s\S]*data-step-marker="1"[\s\S]*data-step-marker="4"/u,
  );
  assert.match(script, /function enterSetupView\(/u);
  assert.match(script, /function enterDashboardView\(/u);
  assert.match(script, /api\("\/api\/local\/dashboard"/u);
});

test("dashboard navigation pairs five visible labels with dependency-free inline SVG icons", async () => {
  const { html, css } = await localDashboardSources();
  const nav = sourceBetween(
    html,
    '<nav id="local-dashboard-nav"',
    "\n          </nav>",
  );
  const destinations = [
    ["dashboard-overview", "Overview"],
    ["dashboard-connections", "Connections"],
    ["dashboard-n8n", "n8n"],
    ["dashboard-credentials", "Credentials"],
    ["dashboard-activity", "Activity"],
  ];
  const icons = Array.from(nav.matchAll(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gu));

  assert.equal(icons.length, 5);
  for (const [, attributes] of icons) {
    assert.match(attributes, /\bclass="dashboard-nav-icon"/u);
    assert.match(attributes, /\baria-hidden="true"/u);
    assert.match(attributes, /\bfocusable="false"/u);
    assert.match(attributes, /\bviewBox="0 0 24 24"/u);
    assert.match(attributes, /\bfill="none"/u);
    assert.match(attributes, /\bstroke="currentColor"/u);
    assert.match(attributes, /\bstroke-width="1\.8"/u);
    assert.match(attributes, /\bstroke-linecap="round"/u);
    assert.match(attributes, /\bstroke-linejoin="round"/u);
  }
  for (const [destination, label] of destinations) {
    const anchor = nav.match(
      new RegExp(`<a\\b[^>]*href="#${destination}"[^>]*>([\\s\\S]*?)<\\/a>`, "u"),
    );
    assert.ok(anchor, `missing ${label} navigation link`);
    assert.match(anchor[1], new RegExp(`^\\s*<svg\\b[\\s\\S]*<\\/svg>\\s*${label}\\s*$`, "u"));
  }

  assert.doesNotMatch(nav, /<span[^>]*>\s*[⌂↔◇⌁≋]\s*<\/span>/u);
  assert.doesNotMatch(nav, /<(?:img|image|use)\b/iu);
  const iconRule = cssRuleDeclarations(css, ".local-wizard .dashboard-nav-icon");
  assert.match(iconRule, /width:\s*1\.5rem\s*;/u);
  assert.match(iconRule, /height:\s*1\.5rem\s*;/u);

  const responsiveNavigation = sourceBetween(
    css,
    "@media (max-width: 72rem)",
    "@media (max-width: 48rem)",
  );
  assert.doesNotMatch(
    responsiveNavigation,
    /\.dashboard-nav-icon\s*\{[^}]*display:\s*none/u,
  );
  assert.match(
    responsiveNavigation,
    /\.dashboard-nav-icon\s*\{[^}]*width:\s*1\.25rem[^}]*height:\s*1\.25rem/u,
  );
});

test("dashboard navigation follows direct hashes and browser history", async () => {
  const { css, script } = await localDashboardSources();
  const source = sourceBetween(
    script,
    "function syncDashboardNavigation",
    "\nfunction initializeLocalDashboard",
  );
  const links = [
    "#dashboard-overview",
    "#dashboard-connections",
    "#dashboard-n8n",
    "#dashboard-credentials",
    "#dashboard-activity",
  ].map((href) => ({
    attributes: new Map([["href", href]]),
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  }));
  const window = { location: { hash: "#dashboard-n8n" } };
  const syncDashboardNavigation = runInNewContext(
    `${source}; syncDashboardNavigation;`,
    {
      document: {
        querySelectorAll(selector) {
          assert.equal(selector, "#local-dashboard-nav a");
          return links;
        },
      },
      window,
    },
    { filename: "local-dashboard-navigation.vm.js", timeout: 1_000 },
  );

  syncDashboardNavigation();
  const activeCurrent = links[2].attributes.get("aria-current");
  assert.equal(activeCurrent, "location");
  assert.equal(links[0].attributes.has("aria-current"), false);
  const activeRule = cssRuleDeclarations(
    css,
    `.local-wizard .dashboard-nav-list a[aria-current="${activeCurrent}"]`,
  );
  assert.match(activeRule, /background:\s*var\(--surface-muted\)\s*;/u);

  window.location.hash = "#dashboard-activity";
  syncDashboardNavigation();
  assert.equal(links[4].attributes.get("aria-current"), "location");
  assert.equal(links[2].attributes.has("aria-current"), false);

  window.location.hash = "#not-a-dashboard-section";
  syncDashboardNavigation();
  assert.equal(links[0].attributes.get("aria-current"), "location");
  assert.equal(
    links.filter(({ attributes }) => attributes.has("aria-current")).length,
    1,
  );
});

test("dashboard exposes honest environment, resource, detail, and recovery states", async () => {
  const { html, script } = await localDashboardSources();

  assert.match(
    html,
    /id="dashboard-environment"[^>]*role="status"[^>]*aria-live="polite"/u,
  );
  assert.match(html, /id="dashboard-services"[^>]*aria-live="polite"/u);
  assert.match(
    html,
    /id="dashboard-service-detail"[^>]*aria-labelledby="dashboard-service-detail-title"/u,
  );
  assert.match(html, /id="dashboard-empty"[^>]*hidden/u);
  assert.match(html, /id="dashboard-error"[^>]*role="alert"[^>]*hidden/u);
  assert.match(html, /id="dashboard-refresh"[^>]*type="button"/u);
  assert.match(script, /checking[\s\S]*healthy[\s\S]*stopped[\s\S]*partial[\s\S]*unavailable[\s\S]*stale/u);
  assert.match(script, /textContent/u);
  assert.doesNotMatch(script, /innerHTML/u);
  assert.doesNotMatch(script, /localStorage/u);
});

test("dashboard styling uses a persistent rail, dense rows, responsive navigation, and reduced motion", async () => {
  const { css } = await localDashboardSources();

  assert.match(css, /\.local-dashboard\s*\{[^}]*grid-template-columns:/u);
  assert.match(css, /\.dashboard-rail\s*\{[^}]*position:\s*sticky/u);
  assert.match(css, /\.dashboard-service-row\s*\{[^}]*border-bottom:/u);
  assert.match(css, /\.dashboard-boundary-token/u);
  assert.match(css, /@media \(max-width:\s*72rem\)[\s\S]*\.dashboard-nav-list/u);
  assert.match(css, /@media \(max-width:\s*48rem\)[\s\S]*\.dashboard-service-row/u);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(
    css,
    /\.dashboard-service-row-actions \.button\s*\{[^}]*min-height:\s*2\.75rem/u,
  );
  assert.match(
    css,
    /\.dashboard-fact-copy\s*\{[^}]*min-height:\s*2\.75rem/u,
  );
});

test("local shell owns page composition while dashboard and setup keep their inner desktop grids", async () => {
  const [{ css }, legacyCss] = await Promise.all([
    localDashboardSources(),
    readFile("src/ui/styles.css", "utf8"),
  ]);
  const legacyShell = cssRuleDeclarations(legacyCss, ".shell");
  const localShell = cssRuleDeclarations(css, ".local-wizard .shell");
  const dashboard = cssRuleDeclarations(css, ".local-wizard .local-dashboard");
  const setup = cssRuleDeclarations(css, ".local-wizard .setup-shell");

  assert.match(legacyShell, /display:\s*grid\s*;/u);
  assert.match(localShell, /display:\s*block\s*;/u);
  assert.match(dashboard, /display:\s*grid\s*;/u);
  assert.match(
    dashboard,
    /grid-template-columns:\s*minmax\(13\.5rem,\s*15rem\)\s+minmax\(0,\s*1fr\)\s*;/u,
  );
  assert.match(setup, /display:\s*grid\s*;/u);
  assert.match(
    setup,
    /grid-template-columns:\s*minmax\(19rem,\s*20\.5rem\)\s+minmax\(0,\s*1fr\)\s*;/u,
  );
});

test("dashboard source keeps secrets out and routes credential work through reviewed actions", async () => {
  const { html, script } = await localDashboardSources();

  assert.match(html, /Existing credentials stay hidden/u);
  assert.match(html, /Rotate[^<]*credential/u);
  assert.doesNotMatch(html, /id="dashboard-[^"]*(?:secret|token|password|api-key)"/iu);
  assert.match(script, /const DASHBOARD_ACTIONS = Object\.freeze/u);
  assert.match(script, /function normalizeDashboardSnapshot\(/u);
  assert.match(script, /function renderDashboardAction\(/u);
  assert.doesNotMatch(script, /document\.createElement\("a"\)[\s\S]{0,300}\.href\s*=/u);
});

test("dashboard contract accepts only the fixed sanitized shape and ambiguous partial state", async () => {
  const { script } = await localDashboardSources();
  const normalize = loadDashboardNormalizer(script);
  const input = validDashboardSnapshot();
  const result = normalize(input);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.services[3].state, "partial");
  assert.equal(result.services[3].snapshot, null);
  assert.deepEqual(Array.from(result.services[3].actions), []);

  const preview = structuredClone(input);
  preview.previewMode = true;
  preview.docker = { available: false, version: null, composeVersion: null };
  preview.services = preview.services.map(({ target, label, kind }) => ({
    target,
    label,
    kind,
    managed: false,
    state: "absent",
    snapshot: null,
    actions: ["setup"],
  }));
  assert.equal(normalize(preview).previewMode, true);

  const falsePreview = structuredClone(preview);
  falsePreview.previewMode = false;
  assert.throws(() => normalize(falsePreview), /unexpected dashboard response/u);

  const leakedSecret = structuredClone(input);
  leakedSecret.services[0].snapshot.auth.token = "secret";
  assert.throws(() => normalize(leakedSecret), /unexpected dashboard response/u);

  const inventedEndpointRemoval = structuredClone(input);
  inventedEndpointRemoval.services[0].snapshot.canRemove = true;
  inventedEndpointRemoval.services[0].actions.push("remove");
  assert.throws(
    () => normalize(inventedEndpointRemoval),
    /unexpected dashboard response/u,
  );

  const unknownAction = structuredClone(input);
  unknownAction.services[0].actions[0] = "reveal-credential";
  assert.throws(() => normalize(unknownAction), /unexpected dashboard response/u);

  const remoteEndpoint = structuredClone(input);
  remoteEndpoint.services[0].snapshot.endpoint = "https://example.com/v1";
  assert.throws(() => normalize(remoteEndpoint), /unexpected dashboard response/u);
});

test("dashboard contract preserves explicit default HTTP ports for an owned n8n stack", async () => {
  const { script } = await localDashboardSources();
  const normalize = loadDashboardNormalizer(script);
  const input = validDashboardSnapshot();
  input.services[3] = {
    target: "local-n8n-stack",
    label: "n8n + ngrok",
    kind: "n8n-stack",
    managed: true,
    state: "stopped",
    snapshot: {
      target: "local-n8n-stack",
      assistantMode: "disabled",
      endpoints: {
        n8nLocal: "http://127.0.0.1:80",
        ngrokPublic: "https://workflow.example.ngrok.app",
        ngrokInspector: "http://127.0.0.1:81",
      },
      components: {
        n8n: true,
        ngrok: true,
        codeSandbox: false,
        searxng: false,
      },
      canResume: true,
      canRemove: true,
    },
    actions: ["resume", "remove"],
  };

  const stack = normalize(input).services[3];
  assert.equal(stack.state, "stopped");
  assert.equal(stack.snapshot.endpoints.n8nLocal, "http://127.0.0.1:80");
  assert.equal(stack.snapshot.endpoints.ngrokInspector, "http://127.0.0.1:81");
});

test("dashboard contract accepts sign-in only before rotation on healthy Codex endpoints", async () => {
  const { script } = await localDashboardSources();
  const normalize = loadDashboardNormalizer(script);
  const codexTargets = [
    { index: 1, target: "codex-chatgpt", endpoint: "ws://127.0.0.1:14500" },
    { index: 2, target: "codex-chat", endpoint: "http://127.0.0.1:14501" },
  ];

  for (const { index, target, endpoint } of codexTargets) {
    const healthy = validDashboardSnapshot();
    healthy.services[index] = {
      target,
      label: healthy.services[index].label,
      kind: "endpoint",
      managed: true,
      state: "healthy",
      snapshot: {
        target,
        endpoint,
        auth: { configured: true, disclosure: "rotate-only" },
        canRotateCredential: true,
      },
      actions: ["sign-in", "rotate-credential"],
    };
    assert.deepEqual(
      Array.from(normalize(healthy).services[index].actions),
      ["sign-in", "rotate-credential"],
    );

    const reversed = structuredClone(healthy);
    reversed.services[index].actions.reverse();
    assert.throws(() => normalize(reversed), /unexpected dashboard response/u);

    const stopped = structuredClone(healthy);
    stopped.services[index].state = "stopped";
    stopped.services[index].actions = [];
    assert.deepEqual(Array.from(normalize(stopped).services[index].actions), []);
  }

  const openAiSignIn = validDashboardSnapshot();
  openAiSignIn.services[0].actions = ["sign-in", "rotate-credential"];
  assert.throws(() => normalize(openAiSignIn), /unexpected dashboard response/u);

  const absentCodexSignIn = validDashboardSnapshot();
  absentCodexSignIn.services[1].actions = ["sign-in", "setup"];
  assert.throws(() => normalize(absentCodexSignIn), /unexpected dashboard response/u);
});

test("dashboard interactions use native keyboard controls and preserve reviewed wizard routes", async () => {
  const { html, script } = await localDashboardSources();

  assert.match(html, /id="dashboard-title" tabindex="-1"/u);
  assert.match(html, /id="setup-back-to-dashboard"[^>]*type="button"/u);
  assert.match(script, /select\.type = "button";[\s\S]*aria-pressed/u);
  assert.match(script, /button\.type = "button";[\s\S]*runDashboardAction/u);
  assert.match(script, /showDashboardRemovalReview\(service\)/u);
  assert.match(script, /showDashboardRotationReview\(service\)/u);
});

test("Codex sign-in action opens endpoint-only existing-install management without starting login", async () => {
  const { html, script } = await localDashboardSources();
  const actionSource = sourceBetween(
    script,
    "function resetDashboardActionReview",
    "\nfunction renderDashboardAction",
  );
  const chatStateSource = sourceBetween(
    script,
    "function clearChatTesterError",
    "\nfunction assertChatTesterKey",
  );
  const elements = new Map();
  const makeNode = (id) => ({
    checked: true,
    children: [],
    clickCount: 0,
    disabled: false,
    focus() {},
    hidden: false,
    href: "https://example.invalid/stale-login",
    id,
    removeAttribute(name) {
      if (name === "href") this.href = "";
    },
    replaceChildren(...children) {
      this.children = children;
      this.textContent = children.map((child) => child.textContent ?? "").join(" ");
    },
    textContent: `stale-${id}`,
    value: `stale-${id}`,
    click() {
      this.clickCount += 1;
    },
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeNode(id));
    return elements.get(id);
  };
  const resultRows = [
    "result-endpoint-row",
    "result-api-key-row",
    "result-responses-row",
    "result-n8n-row",
    "result-network-row",
    "result-publication-row",
    "result-models-row",
    "result-deployment-row",
    "result-public-url-row",
    "result-assistant-mode-row",
    "result-sandbox-key-row",
    "result-searxng-row",
    "result-n8n-settings-row",
    "result-credential-row",
  ];
  const resultValues = [
    "result-api-key",
    "result-responses",
    "result-n8n",
    "result-network",
    "result-publication",
    "result-models",
    "result-deployment",
    "result-public-url",
    "result-assistant-mode",
    "result-sandbox-key",
    "result-searxng",
    "result-n8n-settings",
    "result-credential",
  ];
  const state = {
    chatTester: {
      conversationId: "stale-conversation",
      encryptedCredential: "stale-encrypted-bearer",
      endpointBaseUrl: "https://example.invalid",
      expiresAt: "2099-01-01T00:00:00.000Z",
      generation: 2,
      keyId: "stale-key",
    },
    dashboardBusy: false,
    dashboardSnapshot: validDashboardSnapshot(),
    installedTarget: null,
  };
  const calls = [];
  const messages = [];
  const runDashboardAction = runInNewContext(
    `${chatStateSource}\n${actionSource}; runDashboardAction;`,
    {
      appendPolicyNotice(container, heading, detail) {
        container.textContent = `${heading} ${detail}`;
      },
      dashboardToWizardTarget(target) {
        return target;
      },
      async enterSetupView(target, options) {
        calls.push(`enter:${target}:${options?.checkDocker}`);
      },
      element,
      invalidatePlan() {},
      isCodexChat(target) {
        return target === "codex-chat";
      },
      isDashboardSnapshotStale() {
        return false;
      },
      renderDashboardSnapshot() {},
      setMessage(message) {
        messages.push(message);
      },
      showDashboardRemovalReview() {},
      showDashboardRotationReview() {},
      showStep(step) {
        calls.push(`step:${step}`);
      },
      showStoppedManagedLocalN8nStack() {},
      state,
    },
    { filename: "local-dashboard-codex-management.vm.js", timeout: 1_000 },
  );
  const service = (target, endpoint) => ({
    actions: ["sign-in", "rotate-credential"],
    kind: "endpoint",
    label: target === "codex-chat" ? "Codex Chat adapter" : "Codex (ChatGPT login)",
    managed: true,
    snapshot: {
      auth: { configured: true, disclosure: "rotate-only" },
      canRotateCredential: true,
      endpoint,
      target,
    },
    state: "healthy",
    target,
  });

  await runDashboardAction(
    service("codex-chat", "http://127.0.0.1:14501"),
    "sign-in",
  );

  assert.deepEqual(calls, ["enter:codex-chat:false", "step:4"]);
  assert.equal(state.installedTarget, "codex-chat");
  assert.equal(element("codex-login-button").clickCount, 0);
  assert.equal(element("install-result-list").hidden, false);
  assert.equal(element("result-endpoint-row").hidden, false);
  assert.equal(element("result-endpoint").textContent, "http://127.0.0.1:14501");
  assert.equal(element("one-time-note").hidden, true);
  assert.equal(element("result-credential-row").hidden, true);
  assert.equal(element("result-credential").textContent, "");
  assert.equal(element("codex-production-warning").hidden, false);
  assert.equal(element("codex-login").hidden, false);
  assert.equal(element("device-code-result").hidden, true);
  assert.equal(element("device-code").textContent, "");
  assert.equal(element("device-code-link").href, "");
  assert.equal(element("credential-rotation-note").hidden, false);
  assert.equal(element("rotate-credential-button").disabled, false);
  assert.equal(element("chat-tester").hidden, false);
  assert.equal(element("chat-tester-endpoint").value, "http://127.0.0.1:14501");
  assert.doesNotMatch(element("chat-tester-endpoint").value, /\/chat\/?$/u);
  assert.equal(element("chat-tester-credential").value, "");
  assert.equal(state.chatTester.encryptedCredential, null);
  assert.equal(state.chatTester.keyId, null);
  assert.match(
    element("chat-tester-status").textContent,
    /saved local client bearer capability/iu,
  );
  assert.match(element("chat-tester-status").textContent, /rotate/iu);
  assert.match(element("client-warning").textContent, /bearer[\s\S]*ChatGPT sign-in[\s\S]*separate/iu);
  assert.match(
    element("done-detail").textContent,
    /not (?:been )?(?:checked|started)/iu,
  );
  assert.doesNotMatch(messages.join(" "), /signed in|sign-in completed/iu);
  for (const id of resultRows.filter((id) => id !== "result-endpoint-row")) {
    assert.equal(element(id).hidden, true, `${id} should stay hidden`);
  }
  for (const id of resultValues) {
    assert.equal(element(id).textContent, "", `${id} should be cleared`);
  }

  elements.get("chat-tester-credential").value = "must-not-survive";
  calls.length = 0;
  await runDashboardAction(
    service("codex-chatgpt", "ws://127.0.0.1:14500"),
    "sign-in",
  );

  assert.deepEqual(calls, ["enter:codex-chatgpt:false", "step:4"]);
  assert.equal(state.installedTarget, "codex-chatgpt");
  assert.equal(element("result-endpoint").textContent, "ws://127.0.0.1:14500");
  assert.equal(element("chat-tester").hidden, true);
  assert.equal(element("chat-tester-endpoint").value, "");
  assert.equal(element("chat-tester-credential").value, "");
  assert.match(element("done-title").textContent, /Codex App Server/u);
  assert.match(element("client-warning").textContent, /capability[\s\S]*ChatGPT sign-in[\s\S]*separate/iu);
  assert.equal(element("codex-login-button").clickCount, 0);

  assert.match(
    html,
    /data-copy-target="result-endpoint"[\s\S]*aria-label="Copy local endpoint"/u,
  );
});

test("targeted n8n entry waits for Docker before its selected discovery refresh", async () => {
  const { script } = await localDashboardSources();
  const source = sourceBetween(
    script,
    "function focusVisibleSetupHeading",
    "\nasync function enterDashboardView",
  );
  const calls = [];
  let finishDocker;
  const dockerReady = new Promise((resolve) => {
    finishDocker = resolve;
  });
  const state = { suppressTargetRefresh: false, target: "openai-api" };
  const input = { checked: false };
  const setupHeading = {
    focus(options) {
      calls.push(`focus:choose:${options?.preventScroll}`);
      document.activeElement = setupHeading;
    },
  };
  const elements = new Map([
    ["local-dashboard", { hidden: false }],
    ["local-setup", { hidden: true }],
  ]);
  const document = {
    activeElement: null,
    body: { dataset: {} },
    querySelector(selector) {
      if (selector === '[data-step]:not([hidden]) h2') return setupHeading;
      return input;
    },
  };
  const enterSetupView = runInNewContext(
    `${source}; enterSetupView;`,
    {
      clearDashboardStaleTimer() {},
      document,
      element(id) {
        return elements.get(id);
      },
      async initializeLocalWizard() {
        calls.push("docker:start");
        document.activeElement = { hidden: true, id: "hidden-operation-progress" };
        await dockerReady;
        calls.push("docker:ready");
      },
      isN8nDockerTarget(target) {
        return target === "n8n-openai-oauth";
      },
      async refreshSelectedN8nContext() {
        calls.push("n8n:ready");
      },
      renderTarget() {
        calls.push(`render:suppressed=${state.suppressTargetRefresh}`);
        state.target = "n8n-openai-oauth";
      },
      showStep(step) {
        calls.push(`step:${step}`);
      },
      state,
    },
    { filename: "local-dashboard-entry.vm.js", timeout: 1_000 },
  );

  const entering = enterSetupView("n8n-openai-oauth");
  await Promise.resolve();
  assert.deepEqual(calls, [
    "render:suppressed=true",
    "step:1",
    "docker:start",
  ]);

  finishDocker();
  await entering;
  assert.deepEqual(calls, [
    "render:suppressed=true",
    "step:1",
    "docker:start",
    "docker:ready",
    "n8n:ready",
    "focus:choose:true",
  ]);
  assert.equal(state.suppressTargetRefresh, false);
  assert.equal(document.activeElement, setupHeading);
});

test("returning to the dashboard consumes every pending setup review and one-time value", async () => {
  const { script } = await localDashboardSources();
  const source = sourceBetween(
    script,
    "function clearOneTimeSetupValues",
    "\nfunction initializeLocalDashboard",
  );
  const elements = new Map();
  const node = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        checked: true,
        disabled: false,
        focus() {},
        hidden: false,
        href: "https://example.invalid/pending",
        id,
        removeAttribute(name) {
          if (name === "href") this.href = "";
        },
        textContent: `pending-${id}`,
        value: `pending-${id}`,
      });
    }
    return elements.get(id);
  };
  const state = {
    assistantSearxngReview: { reviewId: "pending" },
    assistantSearxngReviewId: "pending",
    installedTarget: "n8n-ai-assistant",
    n8nOAuthGeneration: 4,
    plan: { target: "n8n-ai-assistant" },
    planId: "pending-plan",
  };
  let chatTesterCleared = false;
  let scrolledWith;
  const calls = [];
  const enterDashboardView = runInNewContext(
    `${source}; enterDashboardView;`,
    {
      async api(path, options) {
        calls.push(`discard:${path}`);
        assert.equal(options.method, "POST");
        assert.deepEqual(Object.keys(options.body), []);
        return { discarded: true };
      },
      clearChatTesterState() {
        chatTesterCleared = true;
      },
      clearDashboardStaleTimer() {},
      document: {
        body: { dataset: {} },
        querySelector() {
          return null;
        },
      },
      element: node,
      invalidatePlan() {
        state.planId = null;
        state.plan = null;
        node("install-confirm").checked = false;
        node("install-settings-button").disabled = true;
      },
      isN8nDockerTarget() {
        return false;
      },
      async loadLocalDashboard() {
        calls.push("inventory");
      },
      preferredScrollBehavior() {
        return "auto";
      },
      renderTarget() {},
      refreshSelectedN8nContext() {},
      showStep() {},
      state,
      window: {
        scrollTo(options) {
          scrolledWith = options;
        },
      },
    },
    { filename: "local-dashboard-return.vm.js", timeout: 1_000 },
  );

  await enterDashboardView();

  assert.deepEqual(calls, ["discard:/api/local/discard", "inventory"]);
  assert.equal(state.planId, null);
  assert.equal(state.plan, null);
  assert.equal(state.installedTarget, null);
  assert.equal(state.assistantSearxngReviewId, null);
  assert.equal(state.assistantSearxngReview, null);
  assert.equal(chatTesterCleared, true);
  assert.equal(scrolledWith.top, 0);
  assert.equal(scrolledWith.behavior, "auto");

  for (const id of [
    "install-confirm",
    "refresh-bridge-confirm",
    "enable-assistant-searxng-confirm",
    "remove-bridge-confirm",
    "remove-assistant-confirm",
    "remove-n8n-stack-confirm",
  ]) {
    assert.equal(node(id).checked, false, `${id} should be unchecked`);
  }
  for (const id of [
    "refresh-bridge-confirm",
    "enable-assistant-searxng-confirm",
    "remove-bridge-confirm",
    "remove-assistant-confirm",
    "remove-n8n-stack-confirm",
  ]) {
    assert.equal(node(id).disabled, true, `${id} should be disabled`);
  }
  for (const id of [
    "install-settings-button",
    "refresh-bridge-button",
    "enable-assistant-searxng-button",
    "remove-bridge-button",
    "remove-assistant-button",
    "remove-n8n-stack-button",
  ]) {
    assert.equal(node(id).disabled, true, `${id} should be disabled`);
  }
  for (const id of [
    "assistant-searxng-edit-review",
    "assistant-searxng-edit-settings",
    "install-result-list",
    "one-time-note",
    "credential-rotation-note",
    "n8n-sidecar-removal",
    "n8n-assistant-removal",
    "n8n-stack-removal",
    "n8n-stack-resume",
    "device-code-result",
  ]) {
    assert.equal(node(id).hidden, true, `${id} should be hidden`);
  }
  for (const id of [
    "result-credential",
    "result-sandbox-key",
    "result-n8n-settings",
    "device-code",
    "assistant-searxng-edit-sandbox",
    "assistant-searxng-edit-search",
    "assistant-searxng-edit-result",
  ]) {
    assert.equal(node(id).textContent, "", `${id} should be cleared`);
  }
  for (const id of [
    "platform-api-key",
    "ngrok-authtoken",
    "ngrok-basic-auth-username",
    "ngrok-basic-auth-password",
  ]) {
    assert.equal(node(id).value, "", `${id} should be cleared`);
  }
  assert.equal(node("n8n-oauth-link").hidden, true);
  for (const id of ["n8n-oauth-link", "device-code-link"]) {
    assert.equal(node(id).href, "", `${id} should forget its pending URL`);
  }
});

test("initial dashboard load uses the safe discard transition and refreshes project metadata", async () => {
  const { script } = await localDashboardSources();
  const source = sourceBetween(
    script,
    "function initializeLocalDashboard",
    "\nfunction parseRelmioStreamEvent",
  );
  const listeners = new Map();
  const calls = [];
  const initializeLocalDashboard = runInNewContext(
    `${source}; initializeLocalDashboard;`,
    {
      document: {
        querySelectorAll() {
          return [];
        },
      },
      element(id) {
        return {
          addEventListener(type, handler) {
            listeners.set(`${id}:${type}`, handler);
          },
        };
      },
      async enterDashboardView(options) {
        calls.push(options ?? null);
      },
      async refreshProjectMeta() {
        calls.push("project-meta");
        throw new Error("optional metadata unavailable");
      },
      enterSetupView() {},
      renderDashboardFailure() {
        calls.push("failure");
      },
      showError() {},
      syncDashboardNavigation() {},
      window: { addEventListener() {} },
    },
    { filename: "local-dashboard-initial-entry.vm.js", timeout: 1_000 },
  );

  initializeLocalDashboard();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(listeners.size, 4);
  assert.deepEqual(calls, [null, "project-meta"]);

  listeners.get("dashboard-refresh:click")();
  await Promise.resolve();
  assert.equal(calls.length, 3);
  assert.equal(calls[0], null);
  assert.deepEqual(Object.keys(calls[2]).sort(), [
    "preserveFocus",
    "preserveScroll",
  ]);
  assert.equal(calls[2].preserveFocus, true);
  assert.equal(calls[2].preserveScroll, true);
});

test("dashboard DOM keeps focus on service identity and disables replacement actions", async () => {
  const { script } = await localDashboardSources();
  const focusSource = sourceBetween(
    script,
    "function captureDashboardFocusIdentity",
    "\nfunction appendDashboardFact",
  );
  const actionSource = sourceBetween(
    script,
    "function renderDashboardAction",
    "\nfunction renderDashboardServiceDetail",
  );
  const rowSource = sourceBetween(
    script,
    "function renderDashboardServiceRow",
    "\nfunction renderDashboardCompactService",
  );
  const checkingSource = sourceBetween(
    script,
    "function renderDashboardChecking",
    "\nfunction renderDashboardSnapshot",
  );
  let focusControls = [];
  const created = [];
  const document = {
    activeElement: null,
    body: { dataset: {} },
    createElement(tagName) {
      const node = {
        attributes: new Map(),
        children: [],
        className: "",
        dataset: {},
        disabled: false,
        focusCount: 0,
        hidden: false,
        listeners: new Map(),
        tagName,
        textContent: "",
        addEventListener(name, listener) {
          this.listeners.set(name, listener);
        },
        append(...children) {
          this.children.push(...children);
          this.lastElementChild = this.children.at(-1) ?? null;
        },
        focus(options) {
          this.focusCount += 1;
          this.focusOptions = options;
          document.activeElement = this;
        },
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
        querySelector() {
          return null;
        },
      };
      created.push(node);
      return node;
    },
    querySelectorAll(selector) {
      if (selector === ".dashboard-service-select") {
        return created.filter(({ className }) => className === "dashboard-service-select");
      }
      if (selector === "[data-dashboard-service]") return focusControls;
      if (selector === "[data-dashboard-action], .dashboard-service-select") {
        return focusControls;
      }
      return [];
    },
  };
  const detail = document.createElement("section");
  const elements = new Map([["dashboard-service-detail", detail]]);
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, document.createElement("div"));
    return elements.get(id);
  };
  const state = {
    dashboardBusy: false,
    dashboardFocusIdentity: null,
    dashboardSelectedTarget: null,
  };
  const controls = runInNewContext(
    `${focusSource}\n${actionSource}\n${rowSource}\n${checkingSource}; ({ captureDashboardFocusIdentity, restoreDashboardFocus, renderDashboardAction, renderDashboardServiceRow, renderDashboardChecking });`,
    {
      DASHBOARD_ACTION_SET: new Set([
        "setup",
        "resume",
        "remove",
        "sign-in",
        "rotate-credential",
        "refresh-credential",
      ]),
      dashboardBoundary() {
        return "Loopback only";
      },
      dashboardServiceDescription() {
        return "Available through reviewed setup.";
      },
      dashboardStateLabel() {
        return "Not configured";
      },
      dashboardStatusDot() {
        return document.createElement("span");
      },
      document,
      element,
      clearDashboardStaleTimer() {},
      renderDashboardServiceDetail() {},
      runDashboardAction() {
        throw new Error("disabled replacement action must not run");
      },
      state,
    },
    { filename: "local-dashboard-focus.vm.js", timeout: 1_000 },
  );
  const service = {
    actions: ["setup"],
    kind: "endpoint",
    label: "OpenAI API",
    managed: false,
    snapshot: null,
    state: "absent",
    target: "openai-api",
  };

  const compactAction = controls.renderDashboardAction(service, "setup", {
    compact: true,
  });
  assert.equal(compactAction.attributes.get("aria-label"), "Set up OpenAI API");
  assert.equal(compactAction.dataset.dashboardService, "openai-api");
  assert.equal(compactAction.dataset.dashboardAction, "setup");

  state.dashboardBusy = true;
  const busyReplacement = controls.renderDashboardAction(service, "setup", {
    compact: false,
  });
  assert.equal(busyReplacement.disabled, true);
  assert.equal(busyReplacement.listeners.has("click"), false);

  state.dashboardBusy = false;
  const row = controls.renderDashboardServiceRow(service, {
    selected: false,
    stale: false,
  });
  const select = row.children[0];
  document.activeElement = select;
  select.listeners.get("click")();
  assert.equal(document.activeElement, select);
  assert.equal(detail.focusCount, 0);
  assert.equal(select.attributes.get("aria-controls"), "dashboard-service-detail");

  document.activeElement = compactAction;
  const identity = controls.captureDashboardFocusIdentity();
  const disabledStaleAction = document.createElement("button");
  disabledStaleAction.dataset.dashboardService = "openai-api";
  disabledStaleAction.dataset.dashboardAction = "setup";
  disabledStaleAction.dataset.dashboardActionLocation = "row";
  disabledStaleAction.disabled = true;
  const replacementSelect = document.createElement("button");
  replacementSelect.dataset.dashboardService = "openai-api";
  replacementSelect.dataset.dashboardControl = "select";
  focusControls = [disabledStaleAction, replacementSelect];
  controls.restoreDashboardFocus(identity);
  assert.equal(document.activeElement, replacementSelect);
  assert.equal(replacementSelect.focusOptions.preventScroll, true);

  compactAction.disabled = false;
  document.activeElement = compactAction;
  focusControls = [compactAction, replacementSelect];
  controls.renderDashboardChecking();
  assert.equal(state.dashboardFocusIdentity.service, "openai-api");
  assert.equal(state.dashboardFocusIdentity.action, "setup");
  assert.equal(state.dashboardFocusIdentity.actionLocation, "row");
  assert.equal(compactAction.disabled, true);
});

test("an all-absent dashboard keeps the fixed six-row inventory visible", async () => {
  const { script } = await localDashboardSources();
  const source = sourceBetween(
    script,
    "function renderDashboardSnapshot",
    "\nfunction renderDashboardFailure",
  );
  const elements = new Map();
  const node = (id = "") => {
    if (!elements.has(id)) {
      elements.set(id, {
        attributes: new Map(),
        children: [],
        className: "",
        disabled: false,
        hidden: false,
        id,
        replaceChildren(...children) {
          this.children = children;
          this.childElementCount = children.length;
        },
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
        textContent: "",
      });
    }
    return elements.get(id);
  };
  const createNode = () => ({
    children: [],
    append(...children) {
      this.children.push(...children);
      this.lastElementChild = this.children.at(-1) ?? null;
    },
    textContent: "",
  });
  const absentServices = validDashboardSnapshot().services.map(
    ({ target, label, kind }) => ({
      target,
      label,
      kind,
      managed: false,
      state: "absent",
      snapshot: null,
      actions: ["setup"],
    }),
  );
  const snapshot = {
    ...validDashboardSnapshot(),
    services: absentServices,
  };
  const state = {
    dashboardBusy: true,
    dashboardSelectedTarget: null,
    dashboardSnapshot: null,
  };
  let selectedService = null;
  const renderDashboardSnapshot = runInNewContext(
    `${source}; renderDashboardSnapshot;`,
    {
      captureDashboardFocusIdentity() {
        return null;
      },
      dashboardStateNode(serviceState) {
        return { serviceState };
      },
      dashboardStatusDot(serviceState) {
        return { serviceState };
      },
      document: {
        body: { dataset: { localView: "dashboard" } },
        createElement: createNode,
      },
      element: node,
      formatDashboardTime() {
        return "Sep 4, 2026";
      },
      isDashboardSnapshotStale() {
        return false;
      },
      renderDashboardCompactService(service) {
        return { lastElementChild: { textContent: "" }, service };
      },
      renderDashboardSectionStatus(label, detail, serviceState) {
        return { summary: { detail, label, serviceState } };
      },
      renderDashboardServiceDetail(service) {
        selectedService = service;
      },
      renderDashboardServiceRow(service) {
        return { service };
      },
      restoreDashboardFocus(identity) {
        assert.equal(identity, null);
      },
      scheduleDashboardStaleExpiry() {},
      state,
    },
    { filename: "local-dashboard-absent.vm.js", timeout: 1_000 },
  );

  renderDashboardSnapshot(snapshot, { stale: false });

  assert.equal(node("dashboard-services").hidden, false);
  assert.equal(node("dashboard-services").children.length, 6);
  assert.equal(node("dashboard-empty").hidden, false);
  assert.equal(node("dashboard-service-detail").hidden, false);
  assert.equal(selectedService.target, "openai-api");
  assert.equal(node("dashboard-n8n-services").children.length, 1);
  assert.equal(
    node("dashboard-n8n-services").children[0].summary.label,
    "No n8n services configured",
  );
  assert.equal(node("dashboard-credential-list").children.length, 0);
});

test("an initial dashboard failure replaces every loading surface with unavailable state", async () => {
  const { script } = await localDashboardSources();
  const source = sourceBetween(
    script,
    "function renderDashboardFailure",
    "\nasync function loadLocalDashboard",
  );
  const elements = new Map();
  const node = (id = "") => {
    if (!elements.has(id)) {
      elements.set(id, {
        children: [],
        className: id === "dashboard-environment"
          ? "dashboard-environment state-checking"
          : "",
        disabled: true,
        focus() {},
        hidden: false,
        querySelector() {
          return { className: "dashboard-status-dot state-checking" };
        },
        replaceChildren(...children) {
          this.children = children;
        },
        setAttribute() {},
        textContent: id.includes("count") ? "0" : "Checking",
      });
    }
    return elements.get(id);
  };
  const createNode = (tagName) => ({
    children: [],
    tagName,
    append(...children) {
      this.children.push(...children);
      this.lastElementChild = this.children.at(-1) ?? null;
    },
    textContent: "",
  });
  const definitions = validDashboardSnapshot().services.map(
    ({ target, label, kind }) => ({ target, label, kind }),
  );
  const state = { dashboardBusy: true, dashboardSnapshot: null };
  const renderDashboardFailure = runInNewContext(
    `${source}; renderDashboardFailure;`,
    {
      clearDashboardStaleTimer() {},
      DASHBOARD_SERVICE_DEFINITIONS: definitions,
      dashboardStatusDot(serviceState) {
        return { serviceState };
      },
      document: {
        body: { dataset: {} },
        createElement: createNode,
      },
      element: node,
      renderDashboardCompactService(service) {
        return { lastElementChild: { textContent: "" }, service };
      },
      renderDashboardSectionStatus(label, detail, serviceState) {
        return { summary: { detail, label, serviceState } };
      },
      renderDashboardServiceRow(service) {
        return { service };
      },
      renderDashboardSnapshot() {
        throw new Error("a missing snapshot must not be rendered");
      },
      state,
    },
    { filename: "local-dashboard-failure.vm.js", timeout: 1_000 },
  );

  renderDashboardFailure();

  assert.equal(node("dashboard-services").hidden, false);
  assert.equal(node("dashboard-services").children.length, 6);
  assert.ok(
    node("dashboard-services").children.every(
      ({ service }) => service.state === "unavailable" && service.actions.length === 0,
    ),
  );
  assert.equal(node("dashboard-empty").hidden, true);
  assert.equal(node("dashboard-healthy-count").textContent, "—");
  assert.equal(node("dashboard-attention-count").textContent, "—");
  assert.equal(node("dashboard-absent-count").textContent, "—");
  assert.equal(node("dashboard-last-checked").textContent, "Unavailable");
  assert.equal(node("dashboard-n8n-services").children.length, 1);
  assert.equal(
    node("dashboard-n8n-services").children[0].summary.serviceState,
    "unavailable",
  );
  assert.ok(node("dashboard-credential-list").children.length > 0);
  assert.equal(node("dashboard-credential-list").hidden, false);
  assert.equal(node("dashboard-activity-list").children.length, 1);
  assert.match(
    node("dashboard-activity-list").children[0].children[1].textContent,
    /inventory unavailable/iu,
  );
  assert.doesNotMatch(
    [
      node("dashboard-last-checked").textContent,
      node("dashboard-environment-title").textContent,
      node("dashboard-activity-list").children[0].children[1].textContent,
    ].join(" "),
    /checking/iu,
  );
});

test("dashboard actions fail closed when the verified snapshot expires", async () => {
  const { script } = await localDashboardSources();
  const staleSource = sourceBetween(
    script,
    "function isDashboardSnapshotStale",
    "\nfunction appendDashboardFact",
  );
  const actionSource = sourceBetween(
    script,
    "async function runDashboardAction",
    "\nfunction renderDashboardAction",
  );
  const snapshot = validDashboardSnapshot();
  const generatedAt = new Date(snapshot.generatedAt).getTime();
  let now = generatedAt + 1_000;
  class TestDate extends Date {
    static now() {
      return now;
    }
  }
  const state = {
    dashboardBusy: false,
    dashboardSnapshot: snapshot,
    dashboardStaleTimer: 91,
  };
  const clearedTimers = [];
  let pendingTimer = null;
  const staleRenders = [];
  let setupEntries = 0;
  let managementViews = 0;
  const dashboardError = {
    focusCalled: false,
    hidden: true,
    textContent: "",
    focus() {
      this.focusCalled = true;
    },
  };
  const controls = runInNewContext(
    `const DASHBOARD_STALE_AFTER_MS = 300000;\n${staleSource}\n${actionSource}\n({ scheduleDashboardStaleExpiry, runDashboardAction });`,
    {
      Date: TestDate,
      dashboardToWizardTarget(target) {
        return target;
      },
      document: { body: { dataset: { localView: "dashboard" } } },
      element(id) {
        assert.equal(id, "dashboard-error");
        return dashboardError;
      },
      async enterSetupView() {
        setupEntries += 1;
      },
      isDashboardSnapshotStale(value) {
        const age = TestDate.now() - new TestDate(value.generatedAt).getTime();
        return age > 300_000 || age < -60_000;
      },
      renderDashboardSnapshot(value, options) {
        staleRenders.push({ options, value });
      },
      showDashboardRemovalReview() {},
      showDashboardCodexSignInManagement() {
        managementViews += 1;
      },
      showDashboardRotationReview() {},
      showStoppedManagedLocalN8nStack() {},
      state,
      window: {
        clearTimeout(id) {
          clearedTimers.push(id);
        },
        setTimeout(callback, delay) {
          pendingTimer = { callback, delay };
          return 92;
        },
      },
    },
    { filename: "local-dashboard-stale.vm.js", timeout: 1_000 },
  );

  controls.scheduleDashboardStaleExpiry(snapshot);
  assert.deepEqual(clearedTimers, [91]);
  assert.equal(state.dashboardStaleTimer, 92);
  assert.equal(pendingTimer.delay, 299_001);

  now = generatedAt + 300_001;
  pendingTimer.callback();
  assert.equal(state.dashboardStaleTimer, null);
  assert.equal(staleRenders.length, 1);
  assert.equal(staleRenders[0].value, snapshot);
  assert.equal(staleRenders[0].options.stale, true);

  staleRenders.length = 0;
  const staleCodexService = {
    ...snapshot.services[1],
    actions: ["sign-in", "rotate-credential"],
  };
  await controls.runDashboardAction(staleCodexService, "sign-in");
  assert.equal(setupEntries, 0);
  assert.equal(managementViews, 0);
  assert.equal(staleRenders.length, 1);
  assert.equal(staleRenders[0].options.stale, true);
  assert.equal(dashboardError.hidden, false);
  assert.equal(dashboardError.focusCalled, true);
  assert.match(dashboardError.textContent, /expired|refresh/iu);
});

test("five-minute stale rerender preserves focus on the same dashboard copy control", async () => {
  const { script } = await localDashboardSources();
  const staleAndFocusSource = sourceBetween(
    script,
    "function isDashboardSnapshotStale",
    "\nfunction appendDashboardFact",
  );
  const factSource = sourceBetween(
    script,
    "function appendDashboardFact",
    "\nfunction dashboardComponentSummary",
  );
  const detailSource = sourceBetween(
    script,
    "function renderDashboardServiceDetail",
    "\nfunction renderDashboardServiceRow",
  );
  const renderSource = sourceBetween(
    script,
    "function renderDashboardSnapshot",
    "\nfunction renderDashboardFailure",
  );
  const snapshot = validDashboardSnapshot();
  const generatedAt = new Date(snapshot.generatedAt).getTime();
  let now = generatedAt + 1_000;
  let pendingTimer = null;
  class TestDate extends Date {
    static now() {
      return now;
    }
  }
  const elements = new Map();
  const makeNode = (tagName = "div") => ({
    attributes: new Map(),
    children: [],
    classList: { add() {}, remove() {} },
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    listeners: new Map(),
    tagName,
    textContent: "",
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    },
    append(...children) {
      this.children.push(...children);
      this.childElementCount = this.children.length;
      this.lastElementChild = this.children.at(-1) ?? null;
    },
    focus(options) {
      this.focusOptions = options;
      document.activeElement = this;
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    replaceChildren(...children) {
      this.children = children;
      this.childElementCount = children.length;
      this.lastElementChild = children.at(-1) ?? null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeNode());
    return elements.get(id);
  };
  const descendants = (root) => {
    const nodes = [];
    const visit = (node) => {
      nodes.push(node);
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    return nodes;
  };
  const body = makeNode("body");
  body.dataset.localView = "dashboard";
  const document = {
    activeElement: body,
    body,
    createElement: makeNode,
    querySelectorAll(selector) {
      assert.equal(selector, "[data-dashboard-service]");
      return Array.from(elements.values()).flatMap(descendants).filter(
        (node) => Boolean(node.dataset?.dashboardService),
      );
    },
  };
  const state = {
    dashboardBusy: false,
    dashboardFocusIdentity: null,
    dashboardSelectedTarget: null,
    dashboardSnapshot: null,
    dashboardStaleTimer: null,
  };
  const controls = runInNewContext(
    `const DASHBOARD_STALE_AFTER_MS = 300000;\n${staleAndFocusSource}\n${factSource}\n${detailSource}\n${renderSource}; ({ renderDashboardSnapshot });`,
    {
      Date: TestDate,
      assistantModeLabel() {
        return "Disabled";
      },
      copyText() {
        return Promise.resolve();
      },
      dashboardBoundary() {
        return "Verified boundary";
      },
      dashboardComponentSummary() {
        return "n8n, ngrok";
      },
      dashboardServiceDescription() {
        return "Verified service";
      },
      dashboardStateLabel(serviceState) {
        return serviceState;
      },
      dashboardStateNode(serviceState) {
        const node = makeNode("span");
        node.textContent = serviceState;
        return node;
      },
      dashboardStatusDot() {
        return makeNode("span");
      },
      document,
      element,
      flashCopied() {},
      formatDashboardTime() {
        return "Sep 4, 2026";
      },
      renderDashboardAction() {
        return null;
      },
      renderDashboardCompactService() {
        const item = makeNode("li");
        item.append(makeNode("span"), makeNode("span"));
        return item;
      },
      renderDashboardSectionStatus() {
        return makeNode("li");
      },
      renderDashboardServiceRow(service) {
        const item = makeNode("li");
        const select = makeNode("button");
        select.dataset.dashboardService = service.target;
        select.dataset.dashboardControl = "select";
        item.append(select);
        return item;
      },
      state,
      window: {
        clearTimeout() {},
        setTimeout(callback, delay) {
          pendingTimer = { callback, delay };
          return 77;
        },
      },
    },
    { filename: "local-dashboard-stale-focus.vm.js", timeout: 1_000 },
  );
  const copyButton = () => descendants(element("dashboard-service-facts")).find(
    ({ tagName }) => tagName === "button",
  );

  controls.renderDashboardSnapshot(snapshot, { stale: false });
  const focusedBeforeExpiry = copyButton();
  assert.equal(focusedBeforeExpiry.dataset.dashboardService, "openai-api");
  assert.equal(focusedBeforeExpiry.dataset.dashboardFact, "endpoint");
  focusedBeforeExpiry.focus();
  assert.equal(pendingTimer.delay, 299_001);

  now = generatedAt + 300_001;
  pendingTimer.callback();

  const focusedAfterExpiry = copyButton();
  assert.notEqual(focusedAfterExpiry, focusedBeforeExpiry);
  assert.equal(document.activeElement, focusedAfterExpiry);
  assert.equal(focusedAfterExpiry.focusOptions.preventScroll, true);
});

test("dashboard offers failure-safe copy controls only for approved endpoint URLs", async () => {
  const { script } = await localDashboardSources();
  const factSource = sourceBetween(
    script,
    "function appendDashboardFact",
    "\nfunction dashboardComponentSummary",
  );
  const detailSource = sourceBetween(
    script,
    "function renderDashboardServiceDetail",
    "\nfunction renderDashboardServiceRow",
  );
  const elements = new Map();
  const makeNode = (tagName = "div") => ({
    attributes: new Map(),
    children: [],
    classList: { add() {}, remove() {} },
    className: "",
    dataset: {},
    disabled: false,
    focus() {
      this.focusCalled = true;
    },
    hidden: true,
    listeners: new Map(),
    tagName,
    textContent: "",
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    },
    append(...children) {
      this.children.push(...children);
      this.lastElementChild = this.children.at(-1) ?? null;
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    replaceChildren(...children) {
      this.children = children;
      this.childElementCount = children.length;
      this.lastElementChild = children.at(-1) ?? null;
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeNode());
    return elements.get(id);
  };
  const copied = [];
  let copyShouldFail = false;
  const renderDashboardServiceDetail = runInNewContext(
    `${factSource}\n${detailSource}; renderDashboardServiceDetail;`,
    {
      assistantModeLabel() {
        return "Disabled";
      },
      copyText(value) {
        if (copyShouldFail) return Promise.reject(new Error("denied"));
        copied.push(value);
        return Promise.resolve();
      },
      dashboardBoundary() {
        return "Verified boundary";
      },
      dashboardComponentSummary() {
        return "n8n, ngrok";
      },
      dashboardServiceDescription() {
        return "Verified service";
      },
      dashboardStateLabel() {
        return "Healthy";
      },
      document: { createElement: makeNode },
      element,
      flashCopied(button) {
        button.copied = true;
      },
      renderDashboardAction() {
        return null;
      },
    },
    { filename: "local-dashboard-copy.vm.js", timeout: 1_000 },
  );
  const copyButtons = () =>
    element("dashboard-service-facts").children.flatMap(
      (row) => row.children.flatMap((child) =>
        child.children.filter(({ tagName }) => tagName === "button")),
    );

  renderDashboardServiceDetail(validDashboardSnapshot().services[0]);
  assert.equal(copyButtons().length, 1);
  assert.equal(copyButtons()[0].textContent, "Copy");
  assert.equal(
    copyButtons()[0].attributes.get("aria-label"),
    "Copy OpenAI API endpoint",
  );
  await copyButtons()[0].listeners.get("click")();
  assert.deepEqual(copied, ["http://127.0.0.1:12435/v1"]);
  assert.equal(copyButtons()[0].copied, true);

  copyShouldFail = true;
  await copyButtons()[0].listeners.get("click")();
  assert.equal(element("dashboard-error").hidden, false);
  assert.equal(element("dashboard-error").focusCalled, true);
  assert.match(element("dashboard-error").textContent, /select.*manually/iu);
  assert.doesNotMatch(element("dashboard-error").textContent, /127\.0\.0\.1/u);

  renderDashboardServiceDetail({
    actions: [],
    kind: "n8n-stack",
    label: "n8n + ngrok",
    managed: true,
    snapshot: {
      assistantMode: "disabled",
      components: { n8n: true, ngrok: true, codeSandbox: false, searxng: false },
      endpoints: {
        n8nLocal: "http://127.0.0.1:5678/",
        ngrokPublic: "https://workflow.example.ngrok.app/",
        ngrokInspector: "http://127.0.0.1:4040/",
      },
    },
    state: "healthy",
  });
  assert.equal(copyButtons().length, 3);
  assert.ok(
    copyButtons().every((button) =>
      !/credential|secret|password|key/iu.test(button.attributes.get("aria-label"))),
  );

  renderDashboardServiceDetail(validDashboardSnapshot().services[5]);
  assert.equal(copyButtons().length, 0);
});

test("scripted page transitions honor reduced-motion preferences", async () => {
  const { script } = await localDashboardSources();
  const source = sourceBetween(
    script,
    "function preferredScrollBehavior",
    "\nif (typeof document",
  );
  const preference = { matches: true };
  const preferredScrollBehavior = runInNewContext(
    `${source}; preferredScrollBehavior;`,
    {
      window: {
        matchMedia(query) {
          assert.equal(query, "(prefers-reduced-motion: reduce)");
          return preference;
        },
      },
    },
    { filename: "local-dashboard-motion.vm.js", timeout: 1_000 },
  );

  assert.equal(preferredScrollBehavior(), "auto");
  preference.matches = false;
  assert.equal(preferredScrollBehavior(), "smooth");
  assert.match(
    script,
    /function showStep\([\s\S]*window\.scrollTo\(\{ top: 0, behavior: preferredScrollBehavior\(\) \}\)/u,
  );
  assert.match(
    script,
    /function enterDashboardView\([\s\S]*window\.scrollTo\(\{ top: 0, behavior: preferredScrollBehavior\(\) \}\)/u,
  );
});
