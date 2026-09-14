import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "path", "rect", "source", "track", "wbr",
]);

function readyPanelParents(html) {
  const start = html.indexOf('<section class="panel success-panel"');
  assert.notEqual(start, -1, "expected the ready panel");
  const stack = [];
  const parents = new Map();
  const actions = [];
  const tags = /<\/?([A-Za-z][\w:-]*)(?:\s[^>]*)?>/gu;
  tags.lastIndex = start;

  for (const match of html.matchAll(tags)) {
    if (match.index < start) continue;
    const raw = match[0];
    const tag = match[1].toLowerCase();
    const closing = raw.startsWith("</");
    if (closing) {
      if (VOID_ELEMENTS.has(tag)) continue;
      const node = stack.pop();
      assert.ok(node, `unexpected closing </${tag}> in ready panel`);
      assert.equal(node.tag, tag, `invalid ready panel nesting at </${tag}>`);
      if (stack.length === 0) return { actions, parents };
      continue;
    }
    const id = raw.match(/\bid="([^"\s]+)"/u)?.[1] ?? null;
    const classes = new Set((raw.match(/\bclass="([^"]*)"/u)?.[1] ?? "").split(/\s+/u).filter(Boolean));
    const node = { tag, id, classes };
    const parent = stack.at(-1) ?? null;
    if (id) parents.set(id, parent);
    if (classes.has("actions")) actions.push(parent);
    if (!VOID_ELEMENTS.has(tag) && !raw.endsWith("/>") ) stack.push(node);
  }
  assert.fail("ready panel did not close");
}

test("the local wizard offers only OAuth-owned provider runtimes", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);

  assert.match(html, /name="target" value="xai-grok-build" checked/u);
  assert.ok(html.includes("<strong>Grok on this computer</strong>") && html.includes("official SuperGrok sign-in") && html.includes("Chat Completions"));
  for (const target of ["codex-chatgpt", "codex-chat", "n8n-openai-oauth", "n8n-supergrok-oauth", "n8n-ai-assistant", "local-n8n-stack"]) {
    assert.match(html, new RegExp(`name="target" value="${target}"`, "u"));
  }
  for (const retired of ["openai-api", "xai-inference", "n8n-xai-inference"]) {
    assert.doesNotMatch(html, new RegExp(`name="target" value="${retired}"`, "u"));
    assert.doesNotMatch(script, new RegExp(`"${retired}"`, "u"));
  }
  assert.doesNotMatch(html, /platform-api-key|API profile|fresh xAI key/u);
  assert.match(html, /Provider sign-in remains owned by the supported runtime[\s\S]*without collecting or setting up an upstream API key/u);
  assert.doesNotMatch(html, /OpenAI Platform API path/u);
  assert.doesNotMatch(script, /provider-profiles|apiKey:|isApiKeyTarget/u);
});

test("the retained UI keeps service-to-service and local capability protections", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
  ]);

  assert.match(html, /id="result-sandbox-key"/u);
  assert.match(html, /id="result-credential"/u);
  assert.match(html, /id="ngrok-authtoken"/u);
  assert.match(script, /rotate-local-capability/u);
  assert.match(script, /Local ChatGPT OAuth credential \(not Platform API key\)/u);
  assert.match(script, /Provider sessions remain runtime-owned|Official SuperGrok sign-in/u);
  assert.match(script, /grok-build remains a legacy routing alias/u);
  assert.match(script, /For workflow model nodes, turn Use Responses API off and choose From list/u);
  assert.match(script, /Settings > Chat > OpenAI > Edit provider/u);
  assert.match(script, /Verify local health and access before reporting success; provider login and fresh model discovery remain separate/u);
});

test("private SuperGrok keeps n8n discovery but suppresses unrelated ChatGPT management", async () => {
  const script = await readFile("src/ui/local.js", "utf8");

  assert.match(script, /element\("n8n-sidecar-fields"\)\.hidden = !n8nTarget/u);
  assert.match(
    script,
    /element\("detected-local-integration-management"\)\.hidden =\s*n8nSuperGrok \|\| state\.n8nContainers\.length === 0/u,
  );
  assert.match(
    script,
    /isN8nSuperGrok\(state\.target\) \|\| state\.n8nContainers\.length === 0/u,
  );
  assert.match(script, /n8nSuperGrok \? "OpenAI Chat Completions \/v1 inside Docker"/u);
  assert.match(script, /n8nSuperGrok\s*\? "~\/\.relmio\/local\/n8n-supergrok-oauth"/u);
});

test("the local wizard remains an accessible four-step page", async () => {
  const html = await readFile("src/ui/local.html", "utf8");
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /<title>Relmio \| Local Endpoint Setup<\/title>/u);
  assert.match(
    html,
    /ChatGPT for n8n[\s\S]*Unofficial · private connection[\s\S]*Connection details and limits[\s\S]*supports Message a Model and GPT Image generation or editing[\s\S]*Audio, moderation, file management, stored conversations, and video generation are unavailable[\s\S]*never enter that API key into this bridge/u,
  );
  assert.match(html, /data-step-marker="1"[\s\S]*data-step-marker="4"/u);
  assert.match(html, /id="global-message"[^>]*role="status"/u);
  assert.match(html, /id="global-error"[\s\S]*role="alert"/u);
  assert.doesNotMatch(html, /\sonclick=/iu);
});

test("Test AI Chat exposes a quiet accessible streaming lifecycle", async () => {
  const [html, script, css] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
    readFile("src/ui/local.css", "utf8"),
  ]);

  assert.match(html, /id="chat-tester-stop"[\s\S]*aria-label="Stop response"/u);
  assert.match(
    html,
    /id="chat-tester-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u,
  );
  assert.match(
    html,
    /id="chat-tester-transcript"[\s\S]*role="log"[\s\S]*aria-relevant="additions"/u,
  );
  assert.match(script, /nextChatTesterFeedback/u);
  assert.match(script, /new AbortController\(\)/u);
  assert.match(script, /signal: controller\.signal/u);
  assert.match(script, /type: "stopping"/u);
  assert.match(script, /type: "stopped"/u);
  assert.match(script, /data\.text\.length === 0/u);
  assert.match(
    script,
    /if \(feedback\.phase !== previous\.phase\) \{\s*setChatTesterStatus/u,
  );
  assert.match(css, /chat-tester-turn-waiting/u);
  assert.match(css, /chat-tester-stream-cursor/u);

  const reducedMotion = css.slice(
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(
    reducedMotion,
    /chat-tester-turn-waiting[\s\S]*chat-tester-stream-cursor[\s\S]*animation:\s*none/u,
  );
});

test("ready-panel credential and action controls are siblings of its flex heading", async () => {
  const html = await readFile("src/ui/local.html", "utf8");
  const { actions, parents } = readyPanelParents(html);
  const oneTimeNoteParent = parents.get("one-time-note");
  const resultParent = parents.get("install-result-list");

  assert.ok(oneTimeNoteParent?.classes.has("success-panel"));
  assert.ok(resultParent?.classes.has("success-panel"));
  assert.ok(!oneTimeNoteParent?.classes.has("success-heading"));
  assert.ok(!resultParent?.classes.has("success-heading"));
  assert.ok(actions.some((parent) => parent?.classes.has("success-panel")));
  assert.ok(!actions.some((parent) => parent?.classes.has("success-heading")));
});

test("the complete local script bootstraps without retired tail initializers", async () => {
  const { runInNewContext } = await import("node:vm");
  const script = (await readFile("src/ui/local.js", "utf8"))
    .replace(/^import .*?;\r?\n/u, "const readWizardSession = () => null; const bindWizardNavigation = () => {};\n")
    .replace(/import \{[\s\S]*?\} from "\.\/chat-tester-feedback\.js";\r?\n/u, "const INITIAL_CHAT_TESTER_FEEDBACK = {}; const nextChatTesterFeedback = () => ({});\n");
  const makeNode = () => ({
    attributes: new Map(),
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {}, disabled: false, hidden: false, isConnected: true, readOnly: false,
    append() {}, appendChild() {}, addEventListener() {}, focus() {}, removeAttribute() {}, replaceChildren() {}, select() {}, setAttribute() {}, setCustomValidity() {}, setSelectionRange() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, reportValidity() { return true; },
    style: {}, textContent: "", type: "password", value: "",
  });
  const html = await readFile("src/ui/local.html", "utf8");
  const nodes = new Map(
    [...html.matchAll(/\bid="([^"\s]+)"/gu)].map(([, id]) => [id, makeNode()]),
  );
  const createdNodes = new Map();
  const createElement = () => {
    const node = makeNode();
    Object.defineProperty(node, "id", {
      get() { return node._id ?? ""; },
      set(id) { node._id = id; createdNodes.set(id, node); },
    });
    return node;
  };
  const element = (id) => nodes.get(id) ?? createdNodes.get(id) ?? null;
  const document = {
    activeElement: null, body: makeNode(), createElement,
    execCommand() { return false; }, getElementById: element,
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  document.body.dataset = {};
  const window = {
    addEventListener() {}, clearInterval() {}, clearTimeout() {}, location: { hash: "" },
    matchMedia() { return { matches: true }; }, scrollTo() {}, setInterval() { return 1; }, setTimeout() { return 1; },
  };
  runInNewContext(script, { URL, URLSearchParams, AbortController, Date, Intl, JSON, Math, Promise, TextDecoder, TextEncoder, Uint8Array, btoa(value) { return value; }, clearTimeout() {}, crypto: { getRandomValues() {}, subtle: {} }, document, fetch() { throw new Error("fetch must not run without a wizard token"); }, navigator: {}, setTimeout() { return 1; }, window }, { filename: "local-whole-bootstrap.vm.js", timeout: 1_000 });
  await Promise.resolve();
  assert.ok(nodes.has("dashboard-refresh"));
});

test("the complete script renders a healthy OAuth inventory instead of falling back to unavailable", async () => {
  const { runInNewContext } = await import("node:vm");
  const script = (await readFile("src/ui/local.js", "utf8"))
    .replace(/^import .*?;\r?\n/u, "const readWizardSession = () => 'a'.repeat(43); const bindWizardNavigation = () => {};\n")
    .replace(/import \{[\s\S]*?\} from "\.\/chat-tester-feedback\.js";\r?\n/u, "const INITIAL_CHAT_TESTER_FEEDBACK = {}; const nextChatTesterFeedback = () => ({});\n");
  const fixture = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    docker: { available: true, version: "29.7.2", composeVersion: "2.39.1" }, auth: { secretsRevealable: false },
    providers: [["codex-chatgpt", "ChatGPT"], ["codex-chat", "ChatGPT"], ["xai-grok-build", "SuperGrok"], ["n8n-supergrok-oauth", "SuperGrok (n8n)"]].map(([target, label]) => ({ target, label, authentication: "provider-oauth", readiness: "runtime-owned" })),
    services: [
      ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint", "ws://127.0.0.1:14500/", ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"]],
      ["codex-chat", "Codex Chat adapter", "endpoint", "http://127.0.0.1:14501/", ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"]],
      ["xai-grok-build", "SuperGrok", "endpoint", "http://127.0.0.1:14502/", ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"]],
      ["local-n8n-stack", "n8n + ngrok", "n8n-stack"], ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"], ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"], ["n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"],
    ].map(([target, label, kind, endpoint, actions]) => endpoint ? ({ target, label, kind, managed: true, state: "healthy", snapshot: { target, endpoint, auth: { configured: true, disclosure: "rotate-only" }, canRotateCredential: true }, actions }) : target === "n8n-supergrok-oauth" ? ({ target, label, kind, managed: true, state: "healthy", snapshot: { target, endpoint: "http://n8n-supergrok:14502/v1", auth: { configured: true, disclosure: "one-time" }, canRemove: true }, actions: ["sign-in-grok-build", "sign-out-grok-build", "remove-owned-supergrok"] }) : ({ target, label, kind, managed: false, state: "absent", snapshot: null, actions: ["setup"] })),
  };
  const makeNode = () => ({ attributes: new Map(), checked: false, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, disabled: false, hidden: false, isConnected: true, readOnly: false, append() {}, appendChild() {}, addEventListener() {}, focus() {}, removeAttribute() {}, replaceChildren() {}, select() {}, setAttribute() {}, setCustomValidity() {}, setSelectionRange() {}, querySelector() { return null; }, querySelectorAll() { return []; }, reportValidity() { return true; }, style: {}, textContent: "", type: "password", value: "" });
  const html = await readFile("src/ui/local.html", "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"\s]+)"/gu)].map(([, id]) => [id, makeNode()]));
  const createdNodes = new Map();
  const createElement = () => {
    const node = makeNode();
    Object.defineProperty(node, "id", { get() { return node._id ?? ""; }, set(id) { node._id = id; createdNodes.set(id, node); } });
    return node;
  };
  const element = (id) => nodes.get(id) ?? createdNodes.get(id) ?? null;
  const document = { activeElement: null, body: makeNode(), createElement, execCommand() { return false; }, getElementById: element, addEventListener() {}, querySelector(selector) { return selector.includes('name="target"') ? { value: "xai-grok-build", checked: true } : null; }, querySelectorAll() { return []; } }; document.body.dataset = {};
  const window = { addEventListener() {}, clearInterval() {}, clearTimeout() {}, location: { hash: "" }, matchMedia() { return { matches: true }; }, scrollTo() {}, setInterval() { return 1; }, setTimeout() { return 1; } };
  const fetch = async (path) => ({ ok: true, async json() { return path === "/api/local/dashboard" ? fixture : path === "/api/local/project-meta" ? { version: "0.13.0", stars: null } : {}; } });
  runInNewContext(script, { URL, URLSearchParams, AbortController, Date, Intl, JSON, Math, Promise, TextDecoder, TextEncoder, Uint8Array, btoa(value) { return value; }, clearTimeout() {}, crypto: { getRandomValues() {}, subtle: {} }, document, fetch, navigator: {}, setTimeout() { return 1; }, window }, { filename: "local-healthy-dashboard.vm.js", timeout: 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element("dashboard-runtime-health").textContent, "Healthy");
  assert.equal(element("dashboard-provider-readiness").textContent, "Provider-managed · not inspected");
  assert.notEqual(element("dashboard-last-checked").textContent, "Unavailable");
});

test("the local start screen leads with four everyday goals and keeps specialist routes available", async () => {
  const [html, script, css] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
    readFile("src/ui/local.css", "utf8"),
  ]);

  const mainChoices = html.slice(
    html.indexOf('<div class="main-connection-choices">'),
    html.indexOf('<details id="more-connections-and-tools"'),
  );
  for (const [label, target] of [
    ["ChatGPT for n8n", "n8n-openai-oauth"],
    ["Grok for n8n", "n8n-supergrok-oauth"],
    ["Set up new n8n", "local-n8n-stack"],
    ["Grok on this computer", "xai-grok-build"],
  ]) {
    assert.match(mainChoices, new RegExp(`<strong>${label}</strong>[\\s\\S]*?value="${target}"|value="${target}"[\\s\\S]*?<strong>${label}</strong>`, "u"));
  }
  const advancedChoices = html.slice(
    html.indexOf('<details id="more-connections-and-tools"'),
    html.indexOf('<details class="setup-help connection-details">'),
  );
  assert.match(advancedChoices, /<summary>More connections and tools<\/summary>/u);
  for (const target of ["codex-chatgpt", "codex-chat", "n8n-ai-assistant"]) {
    assert.match(advancedChoices, new RegExp(`name="target" value="${target}"`, "u"));
  }
  assert.match(html, /<details class="setup-help connection-details">[\s\S]*Connection details and limits[\s\S]*ChatGPT for n8n/u);
  assert.match(html, /Technical name: local port/u);
  assert.match(html, /Technical name: Docker container/u);
  assert.match(script, /const advancedTarget = codexChat \|\| state\.target === "codex-chatgpt" \|\| assistant;/u);
  assert.match(script, /element\("more-connections-and-tools"\)\.open = true;/u);
  assert.match(css, /\.main-connection-choices,[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(css, /\.target-card-icon[\s\S]*stroke: currentColor/u);
  assert.equal((mainChoices.match(/class="target-option-details"/gu) ?? []).length, 4);
  assert.equal((advancedChoices.match(/class="target-option-details"/gu) ?? []).length, 3);
  assert.equal((html.match(/<summary aria-label="More details about [^"]+">More details<\/summary>/gu) ?? []).length, 7);
  assert.match(mainChoices, /<span class="target-purpose">Use ChatGPT and image models in an n8n workflow\.<\/span>/u);
  assert.match(css, /\.target-option-details summary[\s\S]*cursor: pointer/u);
  assert.doesNotMatch(css, /\.main-choice:not\(:has\(input:checked\)\) \.target-description/u);
});
