import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { siwcAccount, siwcInstallResult } from "./helpers/siwc-wizard.js";
import { normalizeSiwcAccount, siwcErrorFromResponse, siwcErrorText } from "../src/ui/siwc-controls.js";

async function harness() {
  const source = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderInstalledSiwcModels(");
  const end = source.indexOf("\nfunction renderInstallResult", start);
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { children: [], textContent: "", hidden: false,
      replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); } });
    return nodes.get(id);
  };
  const render = runInNewContext(`${source.slice(start, end)}; renderInstalledSiwcModels`, {
    element, state: { catalogLabels: new Map() }, document: { createElement: () => ({}) },
    siwcErrorFromResponse, siwcErrorText,
  });
  return { element, render };
}

test("installed model choices clear stale catalog entries and retain only current account models", async () => {
  const { element, render } = await harness();
  render(["listed-model-a", "listed-model-b"], siwcAccount);
  assert.equal(element("installed-siwc-model").children.length, 2);
  render([], siwcAccount, { readiness: "unverified", catalogFailure: { error: "Catalog unavailable", status: 503, recovery: "retry-later" } });
  assert.equal(element("installed-siwc-model").children.length, 0);
  assert.equal(element("installed-siwc-model").disabled, true);
});

test("post-transfer finalization failure keeps recovery visible and disables plan-use controls", async () => {
  const { element, render } = await harness();
  render(["listed-model"], siwcAccount, { readiness: "unverified", runtimeState: "running",
    finalizationFailure: { error: "Final journal write failed", recovery: "review-again" } });
  assert.equal(element("installed-siwc-models").hidden, false);
  assert.equal(element("installed-siwc-model").disabled, true);
  assert.equal(element("installed-siwc-plan-badge").hidden, true);
  assert.ok(element("installed-siwc-model-status").textContent.length > 0);
});

test("a local finalization failure holds the one-time key instead of telling the person to use it", async () => {
  const source = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
  const start = source.indexOf("function renderInstalledSiwcModels(");
  const end = source.indexOf("\nfunction setChatTesterStatus", start);
  const run = (result) => {
    const nodes = new Map();
    const element = (id) => {
      if (!nodes.has(id)) nodes.set(id, { children: [], textContent: "", hidden: false, disabled: false, open: true,
        replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); } });
      return nodes.get(id);
    };
    const state = { catalogLabels: new Map(), chatTester: {} };
    const render = runInNewContext(`${source.slice(start, end)}; renderInstallResult`, {
      element, state, document: { createElement: () => ({}) },
      normalizeSiwcAccount, siwcErrorFromResponse, siwcErrorText,
      isN8nLocalModel: () => false, isN8nSidecar: (target) => target === "n8n-openai-oauth",
      isN8nSuperGrok: () => false, isN8nAssistant: () => false, isN8nStack: () => false,
      isGrokBuild: () => false, isCodexChat: () => false, clearLocalModelPoll() {},
      renderInstalledSiwcOwner() {},
      appendPolicyNotice(container, heading, detail) { container.heading = heading; container.detail = detail; },
    });
    render({ ...siwcInstallResult(), target: "n8n-openai-oauth", endpoint: "http://n8n-openai-oauth:10531/v1",
      networkName: "n8n_default", ...result });
    return { element, state };
  };
  const ready = run({});
  const held = run({ finalizationFailure: { error: "Final journal write failed", recovery: "review-again" } });
  assert.notEqual(held.element("done-detail").textContent, ready.element("done-detail").textContent);
  assert.notEqual(held.element("client-warning").heading, ready.element("client-warning").heading);
  assert.notEqual(held.element("client-warning").detail, ready.element("client-warning").detail);
  assert.equal(held.element("installed-siwc-plan-badge").hidden, true);
  assert.equal(held.element("installed-siwc-model").disabled, true);
  assert.equal(held.state.installedSiwcModelLocked, true);
  assert.equal(ready.element("installed-siwc-model").disabled, false);
  assert.equal(ready.state.installedSiwcModelLocked, false);
  assert.equal(ready.element("local-siwc-owner").open, false, "session changes start collapsed on the Ready step");
});

test("both Codex target footers use the same SIWC boundary without changing SuperGrok guidance", async () => {
  const source = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
  const predicates = source.slice(source.indexOf("function isCodexChat("), source.indexOf("\nfunction assistantModeLabel"));
  const footer = source.slice(source.indexOf("function renderFooterForTarget("), source.indexOf("\nfunction renderTarget("));
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { lastElementChild: { textContent: "" } });
    return nodes.get(id);
  };
  const render = runInNewContext(`${predicates}\n${footer}; renderFooterForTarget`, { element });
  render("codex-chat");
  const chat = element("local-footer-provider").lastElementChild.textContent;
  render("codex-chatgpt");
  assert.equal(element("local-footer-provider").lastElementChild.textContent, chat);
  render("xai-grok-build");
  assert.notEqual(element("local-footer-provider").lastElementChild.textContent, chat);
});
