import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { getLocalDashboardStatus } from "../src/services/local-dashboard.js";

const snapshot = { target: "n8n-claude-oauth", endpoint: "http://relmio-claude:14502/v1",
  auth: { configured: true, disclosure: "one-time" }, models: ["claude-sonnet-5-5"],
  expiresAt: "2026-11-10T00:00:00.000Z", approvalExpired: false, canRemove: true };
const absent = async () => ({ managed: false, state: "absent" });

test("Claude service and provider definitions agree across server, inventory and browser", async () => {
  const [server, browser] = await Promise.all([readFile("src/web/server.js", "utf8"), readFile("src/ui/local.js", "utf8")]);
  const definitions = (source, start, end, expression) => JSON.parse(JSON.stringify(runInNewContext(
    `${source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))}\n${expression}`, {})));
  const serverTargets = definitions(server, "const LOCAL_DASHBOARD_SERVICE_DEFINITIONS", "const LOCAL_DASHBOARD_PROVIDER_DEFINITIONS", "Object.entries(LOCAL_DASHBOARD_SERVICE_DEFINITIONS).map(([target,value])=>({target,label:value.label,kind:value.kind}))");
  const browserTargets = definitions(browser, "const DASHBOARD_SERVICE_DEFINITIONS", "const DASHBOARD_PROVIDER_DEFINITIONS", "DASHBOARD_SERVICE_DEFINITIONS");
  const inventory = await getLocalDashboardStatus({ getDockerStatus: async () => ({ dockerAvailable: false }),
    inspectLocalEndpoint: absent, inspectLocalN8nStack: absent, inspectLocalN8nSidecar: absent,
    inspectLocalN8nAssistant: absent, inspectLocalN8nSuperGrok: absent, inspectLocalN8nModel: absent,
    inspectLocalN8nClaude: async () => ({ managed: true, state: "healthy", snapshot: { ...snapshot, token: "must-not-leak" } }) });
  assert.deepEqual(serverTargets, browserTargets);
  assert.deepEqual(serverTargets, inventory.services.map(({ target, label, kind }) => ({ target, label, kind })));
  assert.equal(inventory.providers.some(provider => provider.target === snapshot.target && provider.label === "Claude (n8n)"), true);
  const claude = inventory.services.find(service => service.target === snapshot.target);
  assert.deepEqual(claude.actions, ["manage-claude", "remove"]);
  assert.equal(JSON.stringify(claude).includes("must-not-leak"), false);
});

test("Claude browser snapshot rejects extra secret keys and invalid approval/model fields", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const start = script.indexOf("function normalizeN8nClaudeDashboardSnapshot");
  const end = script.indexOf("function normalizeDashboardServiceSnapshot", start);
  const normalize = runInNewContext(`${script.slice(start, end)}\nnormalizeN8nClaudeDashboardSnapshot`, {
    assertDashboardKeys(value, keys) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); },
    dashboardContractError() { return new Error("contract"); },
  });
  assert.equal(normalize(snapshot).endpoint, snapshot.endpoint);
  for (const extra of [{ token: "secret" }, { models: ["claude-fable"] }, { approvalExpired: "false" }, { expiresAt: "invalid" }]) {
    assert.throws(() => normalize({ ...snapshot, ...extra }));
  }
  const html = await readFile("src/ui/local.html", "utf8");
  const reviews = html.match(/<input[^>]+data-claude-review="[^"]+"[^>]*>/gu);
  assert.equal(reviews.length, 4);
  assert.equal(reviews.some(markup => /\bchecked\b/u.test(markup)), false);
  assert.match(html, /value="n8n-claude-oauth"/u);
});
