import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("Back from Details keeps Choose focused when a pending plan completes", async () => {
  const script = await readFile("src/ui/hosting.js", "utf8");
  const views = script.slice(script.indexOf("const VIEW_HEADINGS"), script.indexOf("\nfunction node(", script.indexOf("const VIEW_HEADINGS")));
  const invalidation = script.slice(script.indexOf("function clearError()"), script.indexOf("\nfunction activeProvider(", script.indexOf("function clearError()")));
  const handlers = script.slice(script.indexOf('el("hosting-provider").addEventListener'), script.indexOf("\nasync function loadCatalog()", script.indexOf('el("hosting-provider").addEventListener')));
  const nodes = new Map();
  let activeElement;
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: "", disabled: false, hidden: false, handlers: new Map(),
      addEventListener(name, handler) { this.handlers.set(name, handler); },
      replaceChildren() {}, reportValidity() { return true; },
      focus() { activeElement = this; },
    });
    return nodes.get(id);
  };
  const state = { generation: 0, plan: null, archive: null, requestPending: false };
  const document = { body: { dataset: { hostingView: "details" } } };
  let resolveRequest;
  runInNewContext(`${views}\n${invalidation}\n${handlers}`, {
    el, document, state, token: "fixture-token",
    activeProfile() { return { providerId: "fixture", component: "model" }; },
    planInputs() { return { diskGB: 20 }; },
    randomDeploymentId() { return "fixture-deployment"; },
    fetch() { return new Promise(resolve => { resolveRequest = resolve; }); },
    renderPlan() { document.body.dataset.hostingView = "review"; el("review-title").focus(); },
    renderProvider() {}, renderComponent() {}, downloadBundle() {}, error() {},
  });
  el("hosting-model").value = "qwen3:0.6b";
  const pending = el("hosting-form").handlers.get("submit")({ preventDefault() {} });
  assert.equal(state.requestPending, true);
  el("hosting-details-back").handlers.get("click")();
  assert.equal(document.body.dataset.hostingView, "choose");
  assert.equal(activeElement, el("matrix-title"));
  resolveRequest({ ok: true, json: async () => ({ providerId: "fixture", component: "model" }) });
  await pending;
  assert.equal(document.body.dataset.hostingView, "choose");
  assert.equal(activeElement, el("matrix-title"));
  assert.equal(state.plan, null);
});
