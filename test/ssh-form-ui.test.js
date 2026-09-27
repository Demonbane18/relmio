import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { bindSshAuthentication, createCredentialSshGuard, readSshIdentity, sameSshIdentity, validateSshIdentity } from "../src/ui/ssh-form.js";
import { getHostingProvider } from "../src/domain/hosting-providers.js";

function browserFixture(t) {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, disabled: false, hidden: true, textContent: "", handlers: new Map(), attributes: new Map(),
      addEventListener(event, callback) { const list = this.handlers.get(event) ?? []; list.push(callback); this.handlers.set(event, list); },
      dispatch(event) { for (const callback of this.handlers.get(event) ?? []) callback({ currentTarget: this, preventDefault() {} }); },
      setAttribute(name, value) { this.attributes.set(name, value); }, getAttribute(name) { return this.attributes.get(name); },
      focus() {},
      replaceChildren(...children) { this.children = children; if (!children.some(child => child.value === this.value)) this.value = children[0]?.value ?? ""; },
    });
    return nodes.get(id);
  };
  globalThis.document = { getElementById: element, querySelectorAll: () => [], createElement: () => ({}) };
  globalThis.window = { history: { state: null, replaceState() {} }, location: { pathname: "/local-model-vps", hash: "", reload() {} }, addEventListener() {} };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  element("host").value = "fixture.example";
  element("port").value = "22";
  element("username").value = "ubuntu";
  element("ssh-authentication").value = "password";
  element("ssh-privilege").value = "sudo-n";
  element("hosting-provider").value = "generic";
  return element;
}

const identity = { host: "fixture.example", port: 22, username: "ubuntu", fingerprint: `SHA256:${"a".repeat(43)}`, authentication: "agent", privilege: "sudo-n", loginUid: 1000, effectiveUid: 0, scope: "local-model-only", generation: 1 };

test("agent selection clears password and emits one exact auth discriminator", t => {
  const element = browserFixture(t);
  let invalidated = 0;
  const form = bindSshAuthentication({ token: null, trustId: "trust", allowSudo: true, onChange: () => invalidated++ });
  element("trust").checked = true;
  element("password").value = "must-clear";
  element("ssh-authentication").value = "agent";
  element("ssh-authentication").dispatch("change");
  assert.equal(element("password").value, "");
  assert.equal(element("password").disabled, true);
  assert.equal(element("password").required, false);
  assert.equal(invalidated, 1);
  assert.deepEqual(form.request(identity.fingerprint), { host: "fixture.example", port: 22, username: "ubuntu", useAgent: true, privilege: "sudo-n", expectedFingerprint: identity.fingerprint });
  element("ssh-authentication").value = "password";
  element("ssh-authentication").dispatch("change");
  assert.equal(element("password").disabled, false);
  element("password").value = "single-use";
  const request = form.request(identity.fingerprint);
  assert.equal(request.password, "single-use");
  assert.equal(request.useAgent, false);
  assert.equal(element("password").value, "");
});

test("credential-bearing pages cannot request sudo even if a privilege control is injected", t => {
  const element = browserFixture(t);
  const form = bindSshAuthentication({ token: null, trustId: "trust", onChange() {} });
  element("ssh-authentication").value = "agent";
  assert.equal(form.request(identity.fingerprint).privilege, "root");
});

test("administrative identity changes and connection generation invalidate reuse", () => {
  assert.equal(validateSshIdentity(identity), identity);
  for (const [key, value] of Object.entries({ username: "opc", authentication: "password", privilege: "root", loginUid: 0, scope: "vps", generation: 2, fingerprint: `SHA256:${"b".repeat(43)}` })) {
    assert.equal(sameSshIdentity(identity, { ...identity, [key]: value }), false, key);
  }
  for (const invalid of [{ ...identity, username: undefined }, { ...identity, effectiveUid: 1000 }, { ...identity, scope: "vps" }, { ...identity, generation: undefined }]) {
    assert.throws(() => validateSshIdentity(invalid), /administrative SSH identity/u);
  }
});

test("shared credential pages reject model-only reuse while model page accepts it", async t => {
  browserFixture(t);
  globalThis.fetch = async () => ({ ok: true, json: async () => identity });
  await assert.rejects(() => readSshIdentity("fixture-token"), /local-model-only/u);
  assert.equal(await readSshIdentity("fixture-token", { allowModelOnly: true }), identity);
});

test("unknown hosting product IDs cannot be treated as generic VM guidance", () => {
  assert.throws(() => getHostingProvider(""), RangeError);
  assert.throws(() => getHostingProvider("__proto__"), RangeError);
  assert.throws(() => getHostingProvider({ id: "generic" }), RangeError);
});

test("model wizard preserves selected identity and blocks platform, SDK and unknown SSH", async t => {
  const element = browserFixture(t);
  globalThis.window.history.state = { relmioWizardSession: "a".repeat(43) };
  const calls = [];
  globalThis.fetch = async path => {
    calls.push(path);
    if (path === "/api/ssh/connection") return { ok: false, json: async () => ({ error: "Connect to the VPS first." }) };
    if (path === "/api/ssh/capabilities") return { ok: true, json: async () => ({ agent: { status: "unavailable" } }) };
    if (path === "/api/ssh/fingerprint") return { ok: true, json: async () => ({ fingerprint: identity.fingerprint }) };
    throw new Error("Unexpected SSH operation");
  };
  await import("../src/ui/local-model-vps.js");
  await new Promise(resolve => setImmediate(resolve));
  element("host").value = "my-existing-host.example";
  element("port").value = "2222";
  element("username").value = "custom-admin";
  element("ssh-authentication").value = "password";
  element("ssh-privilege").value = "sudo-n";
  element("password").value = "single-use";
  for (const provider of ["generic", "hostinger", "ovh", "gce", "lightsail"]) {
    element("hosting-provider").value = provider;
    element("hosting-provider").dispatch("change");
    assert.equal(element("scan").disabled, false, provider);
  }
  element("scan").dispatch("click");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(path => path === "/api/ssh/fingerprint").length, 1);
  element("trust").checked = true;
  element("trust").dispatch("change");
  for (const provider of ["local", "render", "gke-autopilot", "cloudflare-containers", "n8n-cloud", "vercel-sandbox"]) {
    element("hosting-provider").value = provider;
    element("hosting-provider").dispatch("change");
    assert.equal(element("hosting-alternative").hidden, false, provider);
    assert.equal(element("scan").disabled, true, provider);
    assert.equal(element("connect").disabled, true, provider);
    assert.equal(element("apply").disabled, true, provider);
    for (const id of ["host", "port", "username", "ssh-authentication", "ssh-privilege", "password", "trust"]) {
      assert.equal(element(id).disabled, true, `${provider}: ${id}`);
    }
    element("scan").dispatch("click");
    element("ssh-form").dispatch("submit");
    await new Promise(resolve => setImmediate(resolve));
  }
  element("hosting-provider").value = "unrecognized-provider";
  element("hosting-provider").dispatch("change");
  assert.equal(element("scan").disabled, true);
  assert.equal(element("connect").disabled, true);
  assert.equal(element("hosting-alternative").hidden, false);
  element("scan").dispatch("click");
  element("ssh-form").dispatch("submit");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(path => path === "/api/ssh/fingerprint").length, 1);
  assert.equal(calls.filter(path => path === "/api/ssh/connect").length, 0);
  assert.equal(element("host").value, "my-existing-host.example");
  assert.equal(element("port").value, "2222");
  assert.equal(element("username").value, "custom-admin");
  assert.equal(element("ssh-authentication").value, "password");
  assert.equal(element("ssh-privilege").value, "sudo-n");
  assert.equal(element("password").value, "single-use");
  assert.equal(element("hosting-guide-link").getAttribute("href"), "/hosting");
});

for (const page of [
  { file: "app.js", end: "\nfunction renderAuthUpdatedAt", review: "/api/plan", apply: "/api/install" },
  { file: "assistant.js", end: "\nasync function loadNetworks", review: "/api/assistant/plan", apply: "/api/assistant/install" },
  { file: "supergrok-vps.js", end: "\nfunction selectedBoundary", review: "/api/vps/supergrok/plan", apply: "/api/vps/supergrok/apply", directBody: true },
]) {
  test(`${page.file} rejects same-name target replacement before review/apply and during async review`, async t => {
    const element = browserFixture(t);
    const hostA = { ...identity, host: "a.example", username: "root", privilege: "root", loginUid: 0, scope: "vps" };
    const hostB = { ...hostA, host: "b.example", fingerprint: `SHA256:${"b".repeat(43)}`, generation: 2 };
    let current = hostA;
    let switchDuringReview = false;
    let rejected = 0;
    const calls = [];
    const fetch = async path => {
      if (path === "/api/ssh/connection") return { ok: true, json: async () => current };
      calls.push(path);
      if (path === "/api/ssh/connect") return { ok: true, json: async () => ({ connected: true, identity: current }) };
      if (path === page.review && switchDuringReview) current = hostB;
      return { ok: true, json: async () => ({ planId: "reviewed", containerName: "same-n8n", networkName: "same-network" }) };
    };
    globalThis.fetch = fetch;
    const sshSession = createCredentialSshGuard({ token: "fixture", onMismatch() { rejected++; } });
    const script = await readFile(`src/ui/${page.file}`, "utf8");
    const start = script.indexOf("async function api(");
    const end = script.indexOf(page.end, start);
    const api = runInNewContext(`${script.slice(start, end)}; api`, { token: "fixture", fetch, sshSession });
    const invoke = (path, body = {}) => api(path, page.directBody ? body : { method: "POST", body });
    const boundary = { containerName: "same-n8n", networkName: "same-network" };
    await invoke("/api/ssh/connect");
    await invoke("/api/discover");
    current = hostB;
    await assert.rejects(() => invoke(page.review, boundary), /authenticated VPS changed/u);
    assert.equal(calls.includes(page.review), false);
    await assert.rejects(() => invoke(page.apply, { ...boundary, planId: "old-plan", confirmed: true }), /authenticated VPS changed/u);
    assert.equal(calls.includes(page.apply), false);
    assert.equal(element("ssh-review-identity").textContent, "");
    assert.equal(rejected, 2);
    // Local OAuth does not require a remote identity, even after rejection.
    await invoke("/api/oauth/status");
    assert.equal(calls.at(-1), "/api/oauth/status");

    current = hostA;
    await invoke("/api/ssh/connect");
    switchDuringReview = true;
    await assert.rejects(() => invoke(page.review, boundary), /authenticated VPS changed/u);
    assert.equal(calls.filter(path => path === page.review).length, 1);
    assert.equal(element("ssh-review-identity").textContent, "");
    // A replacement is adopted only through a new explicit connection response.
    switchDuringReview = false;
    await invoke("/api/ssh/connect");
    const reviewed = await invoke(page.review, boundary);
    assert.equal(reviewed.planId, "reviewed");
    assert.match(element("ssh-review-identity").textContent, /root@b\.example/u);
  });
}

test("initial shared-session adoption happens once and preserves precise model-only guidance", async t => {
  const element = browserFixture(t);
  const rootA = { ...identity, host: "a.example", username: "root", privilege: "root", loginUid: 0, scope: "vps" };
  let current = rootA;
  globalThis.fetch = async () => ({ ok: true, json: async () => current });
  const guard = createCredentialSshGuard({ token: "fixture", onMismatch() {} });
  await guard.adoptCurrent();
  await guard.before("/api/discover");
  current = { ...rootA, host: "b.example", generation: 2 };
  await assert.rejects(() => guard.adoptCurrent(), /authenticated VPS changed/u);
  await assert.rejects(() => guard.adoptCurrent(), /authenticated VPS changed/u);
  await assert.rejects(() => guard.before("/api/plan"), /authenticated VPS changed/u);
  await guard.after("/api/ssh/connect", { identity: current });
  await guard.adoptCurrent();
  await guard.before("/api/plan");
  assert.match(element("ssh-review-identity").textContent, /root@b\.example/u);

  current = identity;
  const modelOnly = createCredentialSshGuard({ token: "fixture", onMismatch() {} });
  await assert.rejects(() => modelOnly.adoptCurrent(), /local-model-only/u);
  assert.match(element("ssh-session").textContent, /local-model-only/u);
  current = rootA;
  await assert.rejects(() => modelOnly.adoptCurrent(), /authenticated VPS changed/u);
});
