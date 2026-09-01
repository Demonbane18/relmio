import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

function createFakeElement({
  checked = false,
  disabled = false,
  textContent = "",
  type = "password",
  value = "",
} = {}) {
  const handlers = new Map();
  const attributes = new Map();
  return {
    attributes,
    checked,
    customValidity: "",
    dataset: {},
    disabled,
    focusCalls: 0,
    handlers,
    hidden: false,
    reportValidityCalls: 0,
    textContent,
    type,
    value,
    addEventListener(typeName, handler) {
      handlers.set(typeName, handler);
    },
    focus() {
      this.focusCalls += 1;
    },
    reportValidity() {
      this.reportValidityCalls += 1;
      return this.customValidity === "";
    },
    setAttribute(name, attributeValue) {
      attributes.set(name, String(attributeValue));
    },
    setCustomValidity(message) {
      this.customValidity = message;
    },
  };
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source end marker: ${endMarker}`);
  return source.slice(start, end);
}

function createCredentialHarness() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  const ngrokAuthtoken = createFakeElement();
  const basicAuthUsername = createFakeElement();
  const basicAuthPassword = createFakeElement();
  const generatePassword = createFakeElement({
    textContent: "Generate strong password",
  });
  const togglePassword = createFakeElement({ textContent: "Show password" });
  const installButton = createFakeElement({ textContent: "Install locally" });
  const installConfirm = createFakeElement({ checked: true });
  const installPanel = createFakeElement();
  const installProgress = createFakeElement();
  const apiCalls = [];
  const messages = [];
  const errors = [];
  const state = {
    installControlStates: [],
    installProgressStartedAt: 0,
    installProgressTimer: null,
    installing: false,
    plan: { target: "local-n8n-stack" },
    planId: "reviewed-plan",
  };
  const installControls = [
    installButton,
    ngrokAuthtoken,
    basicAuthUsername,
    basicAuthPassword,
    generatePassword,
    togglePassword,
  ];
  installPanel.querySelectorAll = () => installControls;

  for (const [id, fakeElement] of [
    ["ngrok-authtoken", ngrokAuthtoken],
    ["ngrok-basic-auth-username", basicAuthUsername],
    ["ngrok-basic-auth-password", basicAuthPassword],
    ["generate-ngrok-basic-auth-password", generatePassword],
    ["toggle-ngrok-basic-auth-password", togglePassword],
    ["install-button", installButton],
    ["install-confirm", installConfirm],
    ["install-panel", installPanel],
    ["install-progress", installProgress],
    ["platform-api-key", createFakeElement()],
  ]) {
    elements.set(id, fakeElement);
  }

  return {
    apiCalls,
    basicAuthPassword,
    basicAuthUsername,
    element,
    elements,
    errors,
    generatePassword,
    installButton,
    installConfirm,
    installPanel,
    installProgress,
    messages,
    ngrokAuthtoken,
    state,
    togglePassword,
  };
}

function loadCredentialControls(script, harness, { randomValues, showError } = {}) {
  const validator = extractBetween(
    script,
    "function validateLocalN8nStackCredentials()",
    "\nfunction resetBasicAuthPasswordVisibility()",
  );
  const helpers = extractBetween(
    script,
    "function resetBasicAuthPasswordVisibility()",
    "\nfunction showStep(step)",
  );
  const generateHandler = extractBetween(
    script,
    'element("generate-ngrok-basic-auth-password").addEventListener("click"',
    '\nelement("toggle-ngrok-basic-auth-password").addEventListener("click"',
  );
  const toggleHandler = extractBetween(
    script,
    'element("toggle-ngrok-basic-auth-password").addEventListener("click"',
    '\nelement("install-settings-button").addEventListener("click"',
  );
  const installHandler = extractBetween(
    script,
    'element("install-button").addEventListener("click"',
    '\nelement("remove-bridge-confirm").addEventListener("change"',
  );
  const sandbox = {
    INSTALL_PROGRESS_PHASES: [
      { afterSeconds: 0, message: "Starting the confirmed local installation…" },
    ],
    api: async (path, options) => {
      harness.apiCalls.push({ options, path });
      return { target: "local-n8n-stack" };
    },
    clearError() {},
    element: harness.element,
    globalThis: undefined,
    invalidatePlan() {},
    isN8nAssistant: () => false,
    isN8nSidecar: () => false,
    isN8nStack: (target) => target === "local-n8n-stack",
    renderInstallResult() {},
    setMessage(message) {
      harness.messages.push(message);
    },
    showError(error) {
      if (showError) showError(error);
      else harness.errors.push(error);
    },
    showStep() {},
    state: harness.state,
    window: {
      clearInterval() {},
      setInterval() {
        return 1;
      },
    },
  };
  if (randomValues) sandbox.crypto = { getRandomValues: randomValues };
  else sandbox.crypto = { getRandomValues() {} };
  // The source uses globalThis.crypto; vm creates the actual global object from
  // the sandbox. Do not replace it with an undefined property.
  delete sandbox.globalThis;

  return runInNewContext(
    `${validator}\n${helpers}\n${generateHandler}\n${toggleHandler}\n${installHandler}\n({
      validate: validateLocalN8nStackCredentials,
      generate: element("generate-ngrok-basic-auth-password").handlers.get("click"),
      toggle: element("toggle-ngrok-basic-auth-password").handlers.get("click"),
      install: element("install-button").handlers.get("click"),
    })`,
    sandbox,
    { filename: "local-n8n-credential-controls-ui.vm.js", timeout: 1_000 },
  );
}

test("the real n8n credential validator rejects blanks, whitespace, pasted commands, and unsafe Basic Auth values", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const cases = [
    {
      name: "blank token",
      token: "",
      expected: "ngrok",
      field: "ngrokAuthtoken",
    },
    {
      name: "whitespace token",
      token: "   \t   ",
      expected: "ngrok",
      field: "ngrokAuthtoken",
    },
    {
      name: "pasted ngrok config command",
      token: "ngrok config add-authtoken fake-agent-token",
      expected: "ngrok",
      field: "ngrokAuthtoken",
    },
    {
      name: "invalid username characters",
      token: "valid-agent-token",
      username: "operator name",
      expected: "Use 1–64 letters",
      field: "basicAuthUsername",
    },
    {
      name: "blank username",
      token: "valid-agent-token",
      username: "",
      expected: "Use 1–64 letters",
      field: "basicAuthUsername",
    },
    {
      name: "whitespace username",
      token: "valid-agent-token",
      username: "   ",
      expected: "Use 1–64 letters",
      field: "basicAuthUsername",
    },
    {
      name: "overlong username",
      token: "valid-agent-token",
      username: "a".repeat(65),
      expected: "Use 1–64 letters",
      field: "basicAuthUsername",
    },
    {
      name: "blank password",
      token: "valid-agent-token",
      username: "operator",
      password: "",
      expected: "12–512 characters",
      field: "basicAuthPassword",
    },
    {
      name: "short password",
      token: "valid-agent-token",
      username: "operator",
      password: "short-pass",
      expected: "12–512 characters",
      field: "basicAuthPassword",
    },
    {
      name: "colon password",
      token: "valid-agent-token",
      username: "operator",
      password: "password-with:colon",
      expected: "without a colon",
      field: "basicAuthPassword",
    },
  ];

  for (const invalidCase of cases) {
    const harness = createCredentialHarness();
    harness.ngrokAuthtoken.value = invalidCase.token;
    harness.basicAuthUsername.value = invalidCase.username ?? "operator";
    harness.basicAuthPassword.value = invalidCase.password ?? "safe-password-123";
    const controls = loadCredentialControls(script, harness);

    assert.equal(controls.validate(), false, invalidCase.name);
    const target = harness[invalidCase.field];
    assert.match(target.customValidity, new RegExp(invalidCase.expected, "u"), invalidCase.name);
    assert.equal(target.reportValidityCalls, 1, `${invalidCase.name}: exact invalid target reported`);
    for (const [fieldName, field] of [
      ["ngrok token", harness.ngrokAuthtoken],
      ["Basic Auth username", harness.basicAuthUsername],
      ["Basic Auth password", harness.basicAuthPassword],
    ]) {
      if (field !== target) assert.equal(field.reportValidityCalls, 0, `${invalidCase.name}: ${fieldName} was not reported`);
    }
  }

  const valid = createCredentialHarness();
  valid.ngrokAuthtoken.value = "valid-agent-token";
  valid.basicAuthUsername.value = "operator_01";
  valid.basicAuthPassword.value = "safe-password-123";
  const validControls = loadCredentialControls(script, valid);
  assert.equal(validControls.validate(), true);
  assert.equal(valid.ngrokAuthtoken.customValidity, "");
  assert.equal(valid.basicAuthUsername.customValidity, "");
  assert.equal(valid.basicAuthPassword.customValidity, "");
  assert.equal(valid.ngrokAuthtoken.reportValidityCalls, 0);
  assert.equal(valid.basicAuthUsername.reportValidityCalls, 0);
  assert.equal(valid.basicAuthPassword.reportValidityCalls, 0);
});

test("the real install button validates before the API boundary and reports the exact invalid field", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createCredentialHarness();
  harness.ngrokAuthtoken.value = "valid-agent-token";
  harness.basicAuthUsername.value = "operator name";
  harness.basicAuthPassword.value = "safe-password-123";
  const controls = loadCredentialControls(script, harness);

  await controls.install({ currentTarget: harness.installButton });

  assert.equal(harness.apiCalls.length, 0, "invalid credentials must not send /api/local/install");
  assert.match(harness.basicAuthUsername.customValidity, /Use 1–64 letters/u);
  assert.equal(harness.basicAuthUsername.reportValidityCalls, 1);
  assert.equal(harness.ngrokAuthtoken.reportValidityCalls, 0);
  assert.equal(harness.basicAuthPassword.reportValidityCalls, 0);
});

test("the real Basic Auth password button generates a secure value and reports secure-generation failure", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const generated = createCredentialHarness();
  const controls = loadCredentialControls(script, generated, {
    randomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  });

  await controls.generate({ currentTarget: generated.generatePassword });

  assert.equal(generated.basicAuthPassword.value, "ab".repeat(24));
  assert.equal(generated.basicAuthPassword.value.length, 48);
  assert.equal(generated.basicAuthPassword.customValidity, "");
  assert.equal(generated.basicAuthPassword.focusCalls, 1);
  assert.match(generated.messages.at(-1), /strong Basic Auth password was generated/u);
  assert.equal(generated.errors.length, 0);

  const failed = createCredentialHarness();
  failed.basicAuthPassword.value = "previous-value";
  loadCredentialControls(script, failed, {
    randomValues() {
      throw new Error("crypto unavailable");
    },
  }).generate({ currentTarget: failed.generatePassword });

  assert.equal(failed.basicAuthPassword.value, "previous-value");
  assert.equal(failed.errors.length, 1);
  assert.match(
    failed.errors[0].message,
    /could not securely generate a password[\s\S]*at least 12 characters[\s\S]*no colon or line break/u,
  );
});

test("the real Basic Auth visibility button toggles type, label, pressed state, and focus", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createCredentialHarness();
  const controls = loadCredentialControls(script, harness);

  await controls.toggle({ currentTarget: harness.togglePassword });
  assert.equal(harness.basicAuthPassword.type, "text");
  assert.equal(harness.togglePassword.textContent, "Hide password");
  assert.equal(harness.togglePassword.attributes.get("aria-pressed"), "true");
  assert.equal(harness.basicAuthPassword.focusCalls, 1);

  await controls.toggle({ currentTarget: harness.togglePassword });
  assert.equal(harness.basicAuthPassword.type, "password");
  assert.equal(harness.togglePassword.textContent, "Show password");
  assert.equal(harness.togglePassword.attributes.get("aria-pressed"), "false");
  assert.equal(harness.basicAuthPassword.focusCalls, 2);
});
