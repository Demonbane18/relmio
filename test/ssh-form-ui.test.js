import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { bindSshAuthentication, clearHostReport, createCredentialSshGuard, describeHostReport, readSshIdentity, renderHostReport, sameSshIdentity, validateSshIdentity } from "../src/ui/ssh-form.js";
import { wizardApiError } from "../src/ui/session.js";
import { siwcErrorFromResponse } from "../src/ui/siwc-controls.js";
import { getHostingProvider } from "../src/domain/hosting-providers.js";
import { buildVpsHostReport } from "../src/domain/vps-host-report.js";

function browserFixture(t) {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, MutationObserver: globalThis.MutationObserver };
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, disabled: false, hidden: true, textContent: "", handlers: new Map(), attributes: new Map(),
      addEventListener(event, callback) { const list = this.handlers.get(event) ?? []; list.push(callback); this.handlers.set(event, list); },
      dispatch(event) { for (const callback of this.handlers.get(event) ?? []) callback({ currentTarget: this, preventDefault() {} }); },
      setAttribute(name, value) { this.attributes.set(name, value); }, getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); },
      checkValidity() { return Boolean(this.value); },
      focus() {},
      replaceChildren(...children) { this.children = children; if (!children.some(child => child.value === this.value)) this.value = children[0]?.value ?? ""; },
    });
    return nodes.get(id);
  };
  globalThis.document = { body: { dataset: {} }, getElementById: element, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({}) };
  globalThis.window = { history: { state: null, replaceState() {} }, location: { pathname: "/local-model-vps", hash: "", reload() {} }, addEventListener() {} };
  globalThis.MutationObserver = class { observe() {} };
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

test("an absent VPS session reads as the not-connected error that callers handle", async t => {
  browserFixture(t);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ connected: false }) });
  for (const options of [{}, { allowModelOnly: true }]) {
    await assert.rejects(() => readSshIdentity("fixture-token", options), { message: "Connect to the VPS first." });
  }
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
    if (path === "/api/ssh/connection") return { ok: true, json: async () => ({ connected: false }) };
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
  assert.equal(globalThis.document.body.dataset.operationBusy, "false");
});

for (const page of [
  { file: "app.js", end: "\nfunction resetVpsOwner", review: "/api/plan", apply: "/api/install" },
  { file: "assistant.js", end: "\nasync function loadNetworks", review: "/api/assistant/plan", apply: "/api/assistant/install" },
  { file: "supergrok-vps.js", end: "\nfunction selectedBoundary", review: "/api/vps/supergrok/plan", apply: "/api/vps/supergrok/apply", directBody: true },
  { file: "claude-vps.js", end: "\nfunction selectedBoundary", review: "/api/vps/claude/plan", apply: "/api/vps/claude/apply", directBody: true },
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

test("late startup SSH probes cannot replace a newer connection decision", async t => {
  const element = browserFixture(t);
  const root = { ...identity, username: "root", privilege: "root", loginUid: 0, scope: "vps" };
  for (const startup of [
    { ok: true, json: async () => ({ connected: false }) },
    { ok: true, json: async () => ({ ...root, host: "former.example", generation: 1 }) },
  ]) {
    let release;
    globalThis.fetch = async path => path === "/api/ssh/connection"
      ? new Promise(resolve => { release = () => resolve(startup); })
      : { ok: true, json: async () => ({ agent: { status: "unavailable" } }) };
    let decision = 0;
    bindSshAuthentication({
      token: "fixture", trustId: "trust", onChange() {},
      shouldApplyConnectionStatus: () => decision === 0,
    });
    const guard = createCredentialSshGuard({
      token: "fixture", onMismatch() {}, onIdentityDecision() { decision++; },
    });
    await guard.after("/api/ssh/connect", { identity: { ...root, host: "new.example", generation: 2 } });
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(element("ssh-session").textContent, /root@new\.example/u);
    assert.match(element("ssh-review-identity").textContent, /root@new\.example/u);
    assert.equal(guard.adoptedIdentity()?.host, "new.example");
    await guard.after("/api/disconnect", {});
    assert.equal(guard.adoptedIdentity(), null);
    element("ssh-session").textContent = "";
  }
});

test("the review shows the SSH host key once, in its own field when the page has one", async t => {
  const element = browserFixture(t);
  const root = { ...identity, username: "root", privilege: "root", loginUid: 0, scope: "vps" };
  const guard = createCredentialSshGuard({ token: "fixture", onMismatch() {} });
  await guard.after("/api/ssh/connect", { identity: root });
  assert.equal(element("ssh-review-fingerprint").textContent, root.fingerprint);
  assert.equal(element("ssh-review-identity").textContent.includes(root.fingerprint), false);
  assert.match(element("ssh-review-identity").textContent, /root@fixture\.example:22/u);
  assert.equal(element("ssh-session").textContent.includes(root.fingerprint), true);

  const byId = globalThis.document.getElementById;
  globalThis.document.getElementById = id => id === "ssh-review-fingerprint" ? null : byId(id);
  const other = createCredentialSshGuard({ token: "fixture", onMismatch() {} });
  await other.after("/api/ssh/connect", { identity: { ...root, generation: 2 } });
  assert.equal(element("ssh-review-identity").textContent.includes(root.fingerprint), true,
    "a review without a host-key field keeps the fingerprint on the server line");
  await other.after("/api/disconnect", {});
  assert.equal(element("ssh-review-identity").textContent, "");
});

test("guard-owned identity is unavailable after replacement and ended connection", async t => {
  const element = browserFixture(t);
  const root = { ...identity, username: "root", privilege: "root", loginUid: 0, scope: "vps" };
  let current = root;
  globalThis.fetch = async () => ({ ok: true, json: async () => current });
  const guard = createCredentialSshGuard({ token: "fixture", onMismatch() {} });
  assert.equal(guard.adoptedIdentity(), null);
  await guard.after("/api/ssh/connect", { identity: root });
  assert.equal(guard.adoptedIdentity()?.host, root.host);
  element("ssh-session").textContent = "No authenticated VPS session.";
  assert.equal(guard.adoptedIdentity()?.host, root.host);
  current = { ...root, host: "replacement.example", generation: 2 };
  await assert.rejects(() => guard.before("/api/plan"), /authenticated VPS changed/u);
  assert.equal(guard.adoptedIdentity(), null);
  await guard.after("/api/ssh/connect", { identity: current });
  await guard.after("/api/install", {});
  assert.equal(guard.adoptedIdentity(), null);
});

for (const page of [
  { file: "app.js", end: "\nfunction resetVpsOwner" },
  { file: "assistant.js", end: "\nasync function loadNetworks" },
  { file: "supergrok-vps.js", end: "\nfunction selectedBoundary", directBody: true },
  { file: "claude-vps.js", end: "\nfunction selectedBoundary", directBody: true },
  { file: "local-model-vps.js", end: '\nfor (const name of ["click"', directBody: true },
]) {
  test(`${page.file} keeps a failed call's status, code and unknown outcome for error help`, async () => {
    const script = await readFile(`src/ui/${page.file}`, "utf8");
    const start = script.indexOf("async function api(");
    const end = script.indexOf(page.end, start);
    assert.ok(start >= 0 && end > start);
    const api = runInNewContext(`${script.slice(start, end)}; api`, {
      token: "fixture", wizardApiError, siwcErrorFromResponse,
      sshSession: { async before() {}, async after() {}, async adoptCurrent() {} },
      fetch: async () => ({ ok: false, status: 504, json: async () => ({
        error: "The remote command timed out.", code: "vps_step_start", remoteOutcomeUnknown: true,
      }) }),
    });
    await assert.rejects(() => api("/api/discover", page.directBody ? {} : { method: "POST", body: {} }), (error) => {
      assert.equal(error.message, "The remote command timed out.");
      assert.equal(error.status, 504);
      assert.equal(error.code, "vps_step_start");
      assert.equal(error.remoteOutcomeUnknown, true);
      return true;
    });
  });
}

const hostFacts = { os: "Ubuntu 22.04.5 LTS", kernel: "5.15.0-140-generic", arch: "aarch64", dockerVersion: "29.5.2",
  composeVersion: "5.6.1", buildxVersion: null, memoryBytes: 8 * 1024 ** 3, cpus: 4, security: ["apparmor", "seccomp", "selinux"] };
const rootSession = { ...identity, username: "root", privilege: "root", loginUid: 0, scope: "vps" };

test("the host report is a one-line label and the warnings for this page's flow, problems first", () => {
  const report = buildVpsHostReport({ identity: rootSession, host: { ...hostFacts, arch: "riscv64" } });
  const grok = describeHostReport(report, "supergrok");
  assert.equal(grok.label, "Server check: CPU problem, 2 warnings");
  assert.equal(grok.facts, "Ubuntu 22.04.5 LTS, riscv64, Docker 29.5.2, Compose 5.6.1.");
  assert.deepEqual(grok.issues.map(({ level }) => level), ["fail", "warn", "warn"]);
  assert.match(grok.issues[0].text, /riscv64 CPU/u);
  // The ChatGPT bridge gets its own CPU warning and the SELinux warning, not Grok's refusal.
  const bridge = describeHostReport(report, "chatgpt");
  assert.equal(bridge.issues.some(({ level }) => level === "fail"), false);
  assert.doesNotMatch(bridge.label, /problem/u);
  assert.equal(bridge.issues.some(({ text }) => /SELinux/u.test(text)), true);
  assert.equal(grok.issues.some(({ text }) => /SELinux/u.test(text)), false);

  const clean = describeHostReport(buildVpsHostReport({ identity: rootSession,
    host: { ...hostFacts, os: "Ubuntu 24.04.4 LTS", arch: "x86_64", buildxVersion: "0.38.1", security: ["apparmor"] } }), "claude");
  assert.equal(clean.label, "Server check: no warnings");
  assert.deepEqual(clean.issues, []);

  // A sudo session fails the root-only pages. The closed row names every failed check once.
  const sudo = describeHostReport(buildVpsHostReport({ identity, host: { ...hostFacts, arch: "riscv64" } }), "claude");
  assert.match(sudo.label, /^Server check: Sign-in and CPU problems, \d warnings$/u);

  // A connection without facts still reports, and anything that is not a report is not shown.
  assert.equal(describeHostReport(buildVpsHostReport({ identity: rootSession }), "claude").facts, "Server facts are unavailable.");
  assert.equal(describeHostReport({ host: hostFacts }, "claude"), null);
  assert.equal(describeHostReport(null, "claude"), null);
  // Text that is not a short string never reaches the page, and an unknown check gets a plain name.
  const odd = describeHostReport({ host: { os: { toString: () => "x" }, arch: "x".repeat(81) },
    rows: [{ level: "warn", text: "x".repeat(241), flows: [] }, { level: "warn", text: 5, flows: [] }, { id: "__proto__", level: "fail", text: "Kept.", flows: "all" }] }, "claude");
  assert.equal(odd.label, "Server check: Server problem");
  assert.equal(odd.facts, "Server facts are unavailable.");
});

test("the SSH guard shows the host report closed, for its selection, and clears it when the session ends", async t => {
  browserFixture(t);
  const node = (extra = {}) => ({
    textContent: "", className: "", children: [], attributes: new Map(),
    append(...children) { this.children.push(...children); },
    prepend(child) { this.children.unshift(child); child.parent = this; },
    remove() { this.parent.children = this.parent.children.filter(item => item !== this); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    ...extra,
  });
  // A row of its own starts hidden. A step's own disclosure starts visible with its summary and text.
  const box = (hidden, label, ...text) => {
    const summary = node({ textContent: label });
    const body = node();
    body.children.push(...text);
    return { hidden, open: false, summary, body, querySelector: selector => selector === "summary" ? summary : body };
  };
  const own = box(true, "Server check");
  const shared = box(false, "About the server check", "static text");
  const boxes = [own, shared];
  globalThis.document.querySelectorAll = selector => selector === "[data-host-report]" ? boxes : [];
  globalThis.document.createElement = () => node();
  const reads = [];
  let report = buildVpsHostReport({ identity: rootSession, host: hostFacts });
  globalThis.fetch = async path => {
    if (path.startsWith("/api/ssh/host-report")) {
      reads.push(path);
      return { ok: true, json: async () => report };
    }
    return { ok: true, json: async () => rootSession };
  };
  const selection = { flow: "claude", container: "", network: "" };
  const guard = createCredentialSshGuard({ token: "fixture", onMismatch() {}, hostReport: () => selection });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  guard.refreshHostReport();
  assert.deepEqual(reads, [], "no report is read before a connection is verified");

  await guard.after("/api/ssh/connect", { identity: rootSession });
  await settle();
  assert.deepEqual(reads, ["/api/ssh/host-report"]);
  for (const item of boxes) {
    assert.equal(item.hidden, false);
    assert.equal(item.open, false, "the report never opens by itself");
    assert.equal(item.summary.textContent, "Server check: 4 warnings");
    const region = item.body.children[0];
    assert.equal(region.attributes.get("role"), "region");
    const [facts, list, note] = region.children;
    assert.equal(facts.textContent, "Ubuntu 22.04.5 LTS, aarch64, Docker 29.5.2, Compose 5.6.1.");
    assert.equal(list.children.length, 4);
    assert.ok(list.children.every(entry => entry.textContent.startsWith("Warning: ")));
    assert.match(note.textContent, /only repeats what Docker reported/u);
  }
  assert.deepEqual(shared.body.children.slice(1), ["static text"], "the step's own text stays under the report");

  // The selected n8n and network are sent, so the server can add the network row.
  Object.assign(selection, { container: "n8n", network: "n8n_default" });
  report = buildVpsHostReport({ identity: rootSession, host: { ...hostFacts, os: "Ubuntu 24.04.4 LTS", arch: "x86_64", security: [] } });
  own.open = true;
  guard.refreshHostReport();
  await settle();
  assert.equal(reads.at(-1), "/api/ssh/host-report?container=n8n&network=n8n_default");
  assert.equal(own.summary.textContent, "Server check: 1 warning");
  assert.equal(own.open, true, "a report the person opened stays open when it changes");
  assert.equal(own.body.children.length, 1, "the earlier details are replaced");

  // From here each report read waits until the test answers it, so it can finish after the session ends.
  const held = [];
  globalThis.fetch = async path => path.startsWith("/api/ssh/host-report")
    ? new Promise(resolve => held.push(value => resolve({ ok: true, json: async () => value })))
    : { ok: true, json: async () => rootSession };
  const answer = async (index, value) => { held[index](value); await settle(); };
  const earlier = buildVpsHostReport({ identity: rootSession, host: hostFacts });
  guard.refreshHostReport();

  await guard.after("/api/disconnect", {});
  assert.equal(own.hidden, true);
  assert.equal(own.open, false);
  assert.equal(own.body.children.length, 0);
  assert.equal(shared.hidden, false);
  assert.equal(shared.summary.textContent, "About the server check");
  assert.deepEqual(shared.body.children, ["static text"]);
  // The read started before the disconnect answers now and is not shown.
  await answer(0, earlier);
  assert.equal(own.hidden, true);
  assert.equal(own.body.children.length, 0);
  assert.equal(shared.summary.textContent, "About the server check");
  assert.deepEqual(shared.body.children, ["static text"]);

  // A read from an earlier session that answers last never replaces the next session's report.
  await guard.after("/api/ssh/connect", { identity: rootSession });
  await answer(1, report);
  guard.refreshHostReport();
  await guard.after("/api/disconnect", {});
  await guard.after("/api/ssh/connect", { identity: rootSession });
  await answer(3, report);
  await answer(2, earlier);
  assert.equal(own.hidden, false);
  assert.equal(own.summary.textContent, "Server check: 1 warning");
  assert.equal(own.body.children[0].children[0].textContent, "Ubuntu 24.04.4 LTS, x86_64, Docker 29.5.2, Compose 5.6.1.");

  // A report that cannot be read is simply not shown.
  globalThis.fetch = async path => path.startsWith("/api/ssh/host-report")
    ? { ok: false, status: 400, json: async () => ({ error: "The host report selection is invalid." }) }
    : { ok: true, json: async () => rootSession };
  guard.refreshHostReport();
  await settle();
  assert.equal(own.hidden, true);
  renderHostReport(report, "claude");
  assert.equal(own.hidden, false);
  clearHostReport();
  assert.equal(own.hidden, true);
});
