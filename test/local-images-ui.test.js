import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const VERIFICATION_URL = "https://auth.openai.com/codex/device";
const owner = { registrationId: "fixture_registration_1", label: "Test ChatGPT account", session: "connected",
  planEnabled: true, planPermission: "granted", ownership: "owned" };

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return source.slice(from, to);
}

async function harness(apiResult) {
  const source = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
  const nodes = new Map();
  const events = [];
  const element = (id) => {
    if (!nodes.has(id)) {
      const handlers = {};
      nodes.set(id, {
        id, handlers, hidden: false, disabled: false, checked: false, open: false, textContent: "", attributes: new Map(),
        get href() { return this.attributes.get("href") ?? ""; },
        set href(value) { this.attributes.set("href", value); },
        set innerHTML(_value) { throw new Error("untrusted text must use textContent"); },
        removeAttribute(name) { this.attributes.delete(name); },
        addEventListener(type, handler) { handlers[type] = handler; },
        focus() { events.push(`focus:${id}`); },
      });
    }
    return nodes.get(id);
  };
  const timers = [];
  const window = {
    setTimeout(callback, delay) { timers.push({ callback, delay, cleared: false }); return timers.length; },
    clearTimeout(handle) { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
  };
  const calls = [];
  const state = { imagesGeneration: 0, imagesTimer: null, installedImages: null, operationBusy: false,
    installedOwner: { target: "n8n-openai-oauth", account: owner } };
  const context = {
    element, window, state, Date,
    api: async (path, options) => { calls.push({ path, body: options?.body }); events.push(`api:${path}`); return apiResult(path, options); },
    setBusy: (_button, busy) => { events.push(busy ? "busy" : "idle"); return true; },
    clearError() {}, showError(error) { events.push(`error:${error.message}`); },
    setMessage(text) { events.push(`message:${text}`); },
  };
  runInNewContext([
    slice(source, "function renderInstalledSiwcOwner(", "\nfunction showDashboardSiwcOwner"),
    slice(source, "// Image generation for the running installed n8n sidecar", "\nfunction clearOneTimeSetupValues"),
    "initializeInstalledImages();",
    "Object.assign(globalThis, { renderInstalledSiwcOwner, renderInstalledImages, checkInstalledImages });",
  ].join("\n"), context);
  const due = () => timers.filter((timer) => !timer.cleared);
  return { context, element, timers, due, calls, events, state };
}

const visibleBlocks = (element) => ["off", "pending", "on"].filter((name) => !element(`installed-images-${name}`).hidden);
// Values made inside the VM have its prototypes; compare their JSON shape.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the local image block shows only for the running owned sidecar and starts from a fresh status check", async () => {
  const ui = await harness(() => ({ state: "off" }));
  const render = (target, state, account = owner) => ui.context.renderInstalledSiwcOwner({ target, state,
    snapshot: { registrationId: owner.registrationId, migrationRequired: false, auth: { configured: true, account } } });
  render("n8n-openai-oauth", "healthy");
  assert.equal(ui.element("installed-images").hidden, false);
  assert.equal(ui.element("local-siwc-images-signout-note").hidden, false);
  for (const [target, state, account] of [["n8n-openai-oauth", "stopped"], ["n8n-openai-oauth", "partial"],
    ["codex-chat", "healthy"], ["n8n-openai-oauth", "healthy", { ...owner, ownership: "transferred" }]]) {
    render(target, state, account);
    assert.equal(ui.element("installed-images").hidden, true, `${target} ${state}`);
  }
  render("n8n-openai-oauth", "healthy");
  ui.element("installed-images").open = true;
  ui.element("installed-images").handlers.toggle({ currentTarget: ui.element("installed-images") });
  await settle();
  assert.deepEqual(plain(ui.calls), [{ path: "/api/local/n8n/siwc/images/status", body: { registrationId: owner.registrationId } }]);
  assert.deepEqual(visibleBlocks(ui.element), ["off"]);
  assert.equal(ui.element("installed-images-start").disabled, true, "sign-in needs the approval box");
  ui.element("installed-images-confirm").checked = true;
  ui.element("installed-images-confirm").handlers.change({ currentTarget: ui.element("installed-images-confirm") });
  assert.equal(ui.element("installed-images-start").disabled, false);
});

test("a pending code shows as text with the fixed sign-in link, polls every 5 seconds and stops when hidden", async () => {
  let pollResult = { state: "pending", pending: { userCode: "<img src=x onerror=alert(1)>", verificationUrl: "https://evil.example/", expiresAt: "2026-10-07T12:15:00.000Z" } };
  const ui = await harness(() => pollResult);
  ui.context.renderInstalledImages(pollResult);
  assert.deepEqual(visibleBlocks(ui.element), ["pending"]);
  assert.equal(ui.element("installed-images-code").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(ui.element("installed-images-link").href, VERIFICATION_URL, "only the fixed Codex page is linked");
  assert.match(ui.element("installed-images-expiry").textContent, /every 5 seconds/u);
  assert.equal(ui.due().length, 1);
  assert.equal(ui.due()[0].delay, 5_000);

  pollResult = { state: "signed-in", account: { email: "<b>images@example.test</b>", planType: "plus", accountIdSuffix: "abc123" } };
  ui.due()[0].callback();
  await settle();
  assert.deepEqual(plain(ui.calls.map(({ path }) => path)), ["/api/local/n8n/siwc/images/login-status"]);
  assert.deepEqual(visibleBlocks(ui.element), ["on"]);
  assert.ok(ui.element("installed-images-status").textContent.includes("<b>images@example.test</b>"));
  assert.equal(ui.element("installed-images-link").href, "");
  assert.equal(ui.due().length, 0, "a finished sign-in is not polled again");

  ui.context.renderInstalledImages({ state: "pending", pending: { userCode: "ABCD-1234", verificationUrl: VERIFICATION_URL, expiresAt: "2026-10-07T12:15:00.000Z" } });
  const stale = ui.due()[0];
  ui.context.renderInstalledImages(null, false);
  assert.equal(ui.element("installed-images").hidden, true);
  assert.equal(ui.due().length, 0);
  stale.callback();
  await settle();
  assert.equal(ui.calls.length, 1, "a poll scheduled before hiding does not run");

  ui.context.renderInstalledImages({ state: "unavailable" });
  assert.deepEqual(visibleBlocks(ui.element), []);
  assert.match(ui.element("installed-images-status").textContent, /^Update the sidecar first/u);
});

test("image sign-out needs its approval and renders the result after the operation ends", async () => {
  const ui = await harness(() => ({ state: "off", revocation: "unconfirmed" }));
  ui.context.renderInstalledImages({ state: "signed-in", account: { accountIdSuffix: "abc123" } });
  const signOut = ui.element("installed-images-signout");
  await signOut.handlers.click({ currentTarget: signOut });
  assert.equal(ui.calls.length, 0);
  assert.match(ui.events.at(-1), /^error:Confirm/u);

  ui.element("installed-images-signout-confirm").checked = true;
  signOut.handlers.click({ currentTarget: signOut });
  await settle();
  assert.deepEqual(plain(ui.calls), [{ path: "/api/local/n8n/siwc/images/action", body: { action: "sign-out", confirmed: true } }]);
  const idle = ui.events.indexOf("idle");
  assert.ok(idle > ui.events.indexOf("api:/api/local/n8n/siwc/images/action") && idle < ui.events.findIndex((event) => event.startsWith("message:")));
  assert.deepEqual(visibleBlocks(ui.element), ["off"]);
  assert.equal(ui.element("installed-images-signout-confirm").checked, false);
  assert.match(ui.element("installed-images-status").textContent, /did not confirm the revocation/u);
});
