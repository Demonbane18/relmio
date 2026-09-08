import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function harness(response) {
  const script = await readFile("src/ui/local.js", "utf8");
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { checked: false, disabled: false, textContent: "", handlers: {}, addEventListener(event, callback) { this.handlers[event] = callback; } });
    return nodes.get(id);
  };
  const calls = [];
  const errors = [];
  const busy = [];
  let invalidated = 0;
  const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start) + start.length));
  const code = between("function validateManagedBridgeUpdateResult", "\nfunction validateAssistantSearxngReview") + between('element("update-bridge-confirm").addEventListener', '\nelement("refresh-bridge-confirm").addEventListener');
  runInNewContext(code, {
    element,
    hasExactKeys: (v, keys) => Boolean(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k)),
    async api(path, options) { calls.push({ path, ...options }); if (response instanceof Error) throw response; return response; },
    clearError() {}, showError(error) { errors.push(error.message); },
    setBusy(button, value) { busy.push(value); return true; },
    invalidatePlan() { invalidated++; }, setMessage() {},
    canUpdateManagedBridgeRuntime: () => true,
    updateManagedBridgeRuntimeControls() {
      element("update-bridge-button").disabled =
        !element("update-bridge-confirm").checked;
    },
  });
  return { element, calls, errors, busy, invalidated: () => invalidated,
    click: () => element("update-bridge-button").handlers.click({ currentTarget: element("update-bridge-button") }) };
}
const valid = { target: "n8n-openai-oauth", runtimeUpdated: true, models: ["gpt-6-astra"], hostPublication: "none", n8nChanged: false };

test("bridge runtime controls require a current managed dashboard action without requiring source sign-in", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const start = script.indexOf("function canUpdateManagedBridgeRuntime");
  const end = script.indexOf("\nfunction renderTarget", start);
  assert.notEqual(start, -1, "expected a managed bridge runtime availability check");
  assert.notEqual(end, -1, "expected the availability check before renderTarget");

  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, { checked: false, disabled: false, hidden: false });
    }
    return nodes.get(id);
  };
  const state = {
    target: "n8n-openai-oauth",
    n8nOAuthExists: false,
    dashboardSnapshotStale: false,
    dashboardSnapshot: {
      services: [{
        target: "n8n-openai-oauth",
        kind: "n8n-oauth-bridge",
        managed: true,
        state: "healthy",
        snapshot: { canRefreshCredential: true },
        actions: ["refresh-credential", "remove"],
      }],
    },
  };
  const context = {
    state,
    element,
    isDashboardSnapshotStale: () => false,
    isN8nSidecar: (target) => target === "n8n-openai-oauth",
  };
  runInNewContext(
    `${script.slice(start, end)}\nglobalThis.updateControls = updateManagedBridgeRuntimeControls;`,
    context,
  );

  context.updateControls();
  assert.equal(element("n8n-sidecar-update").hidden, false);
  assert.equal(element("update-bridge-confirm").disabled, false);
  element("update-bridge-confirm").checked = true;
  context.updateControls();
  assert.equal(element("update-bridge-button").disabled, false);

  state.dashboardSnapshotStale = true;
  context.updateControls();
  assert.equal(element("n8n-sidecar-update").hidden, true);
  assert.equal(element("update-bridge-confirm").checked, false);
  assert.equal(element("update-bridge-button").disabled, true);

  state.dashboardSnapshotStale = false;
  state.target = "codex-chatgpt";
  context.updateControls();
  assert.equal(element("n8n-sidecar-update").hidden, true);

  state.target = "n8n-openai-oauth";
  state.dashboardSnapshot.services[0].actions = ["remove"];
  context.updateControls();
  assert.equal(element("n8n-sidecar-update").hidden, true);
});

test("existing bridge update requires its own confirmation and no new sign-in", async () => {
  const h = await harness(valid);
  await h.click();
  assert.equal(h.calls.length, 0);
  h.element("update-bridge-confirm").checked = true;
  await h.click();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, "/api/local/n8n/sidecar/update");
  assert.equal(JSON.stringify(h.calls[0].body), '{"confirmed":true}');
  assert.equal(h.invalidated(), 1);
  assert.deepEqual(h.busy, [true, false]);
  assert.equal(h.element("update-bridge-confirm").checked, false);
  assert.equal(h.element("update-bridge-button").disabled, true);
  assert.match(h.element("update-bridge-status").textContent, /runtime updated.*Saved sign-in preserved; n8n unchanged/u);
});

test("bridge update failures and malformed success do not claim completion", async () => {
  for (const result of [new Error("Build failed"), { ...valid, n8nChanged: true }, { ...valid, models: [] }, { ...valid, extraSecret: "test" }]) {
    const h = await harness(result);
    h.element("update-bridge-confirm").checked = true;
    await h.click();
    assert.equal(h.errors.length, 1);
    assert.deepEqual(h.busy, [true, false]);
    assert.match(h.element("update-bridge-status").textContent, /did not complete/u);
  }
});

test("local wizard explains runtime updates separately from sign-in refresh", async () => {
  const html = await readFile("src/ui/local.html", "utf8");
  assert.match(html, /id="n8n-sidecar-update"/u);
  assert.match(html, /id="update-bridge-confirm" type="checkbox"/u);
  assert.match(html, /id="update-bridge-button"[^>]*disabled>Update bridge runtime/u);
  assert.match(html, /No new sign-in is needed/u);
  assert.match(html, /This action only updates the sign-in/u);
});
