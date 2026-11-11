import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachBrowserReopenOnEnter, openBrowser } from "../src/browser.js";
import { ensureLocalDashboardBrowserLaunchRoot } from "../src/services/local-dashboard-control.js";
import { startWizardServer } from "../src/web/server.js";
import { CLAUDE_COMPANION, claudeCompanionPin, reviewClaudeCompanion } from "../src/claude/companion.js";
import { DEFAULT_LOCAL_CLAUDE_MODELS, validateClaudeReview } from "../src/domain/local-n8n-claude.js";
import { createLocalN8nModelPlan } from "../src/domain/local-n8n-model.js";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const previewRegistrationId = "preview_registration_1";
const previewAccount = Object.freeze({
  registrationId: previewRegistrationId, label: "Preview account",
  email: "preview@example.test", identity: "verified", session: "connected",
  planPermission: "granted", planEnabled: true, ownership: "owned",
  generation: "68f572d8-2b56-4ef2-a6c2-7791078a1161",
  ownerHostId: "urn:uuid:38031c97-8e16-402b-85f8-6c7eb17e72bb",
  ownerRuntimeId: "local", needsPlanWelcome: false,
});

// Select sanitized UI state: RELMIO_PREVIEW_FIXTURE=signed-out|connected|reauthorize|
// plan-not-granted|usage-limit|handoff-pending|staged node scripts/preview.js.
export const PREVIEW_FIXTURES = Object.freeze([
  "signed-out", "connected", "reauthorize", "plan-not-granted", "usage-limit", "handoff-pending", "staged",
]);

// Synthetic host and provider data only. These fixtures never inspect a machine or sign in.
const previewBoundary = Object.freeze({ containerId: "a".repeat(64), networkId: "b".repeat(64) });
const previewHost = Object.freeze({
  os: "Ubuntu 24.04.4 LTS", kernel: "6.8.0-117-generic", arch: "x86_64",
  dockerVersion: "29.5.2", composeVersion: "5.6.1", buildxVersion: "0.38.1",
  memoryBytes: 32 * 1024 ** 3, cpus: 8, security: Object.freeze(["apparmor", "seccomp", "cgroupns"]),
});
function refusePreviewWrite() {
  throw Object.assign(new Error("Server changes are disabled in sanitized preview mode."), { statusCode: 403 });
}
function requirePreviewInstall(action) {
  if (action !== "install") throw new Error("The preview companion is not installed. Review an installation instead.");
}

export function createPreviewServices(fixture = "connected") {
  if (!PREVIEW_FIXTURES.includes(fixture)) throw new TypeError("Unknown sanitized preview fixture.");
  const account = { ...previewAccount,
    session: ["signed-out", "reauthorize"].includes(fixture) ? fixture : "connected",
    planPermission: fixture === "plan-not-granted" ? "not-granted" : "granted",
    planEnabled: !["signed-out", "reauthorize", "plan-not-granted"].includes(fixture),
    ownership: fixture === "handoff-pending" ? "handoff-pending" : "owned",
  };
  // The guide choice lives in memory for this preview run; preview never writes the preference file.
  const preferences = {};
  const expiresAt = new Date(Date.now() + (7 * 24 - 1) * 3600_000).toISOString();
  return {
  async readUiPreferences() { return { ...preferences }; },
  async writeUiPreferences({ preferences: { guide } }) { preferences.guide = guide; },
  async listAuthRegistrations() { return [account]; },
  async getSelectedRegistration() { return previewRegistrationId; },
  async getAuthStatus({ registrationId }) {
    return { ...account, exists: registrationId === previewRegistrationId && account.session === "connected" };
  },
  async readRegistration({ registrationId }) {
    if (registrationId !== previewRegistrationId) throw new Error("Unknown preview account.");
    return { registrationId, clientId: "preview-client", generation: account.generation };
  },
  async listSiwcModels() { return []; },
  async getProjectMeta() {
    return { version: "preview", stars: null, checkedAt: new Date().toISOString() };
  },
  async getSshCapabilities() { return { agent: { status: "unavailable", transport: null } }; },
  async reviewVpsSiwcTarget() { return { n8nContainerId: "a".repeat(64), networkId: "b".repeat(64) }; },
  async getVpsSiwcInstallationStatus() {
    return fixture === "staged" ? { state: "staged", staging: {
      installId: "preview_installation_1", registrationId: previewRegistrationId, stage: "prepared",
    } } : { state: "absent" };
  },
  async scanHostFingerprint() {
    return "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  },
  async connectVerified(request) {
    return {
      close() {},
      host: previewHost,
      exec: refusePreviewWrite,
      upload: refusePreviewWrite,
      publishManagedFile: refusePreviewWrite,
      identity: Object.freeze({
        host: request.host, port: Number(request.port), fingerprint: request.expectedFingerprint,
        username: request.username, authentication: request.useAgent ? "agent" : "password",
        privilege: request.privilege, loginUid: request.privilege === "root" ? 0 : 1000, effectiveUid: 0,
      }),
      scope: request.privilege === "root" ? "vps" : "local-model-only",
    };
  },
  async discoverN8n() {
    return {
      dockerVersion: previewHost.dockerVersion,
      composeVersion: previewHost.composeVersion,
      containers: [
        {
          id: "a".repeat(64),
          image: "docker.n8n.io/n8nio/n8n",
          name: "n8n-n8n-1",
          state: "running",
          composeProject: "n8n", n8nSandboxPresent: false,
        },
      ],
    };
  },
  async discoverNetworks() {
    return { networks: ["proxy"], recommended: "proxy",
      support: { proxy: { supported: true, reason: null, message: null } } };
  },
  async inspectVpsSuperGrok() {
    return { state: "absent", ...previewBoundary, installId: null, endpoint: "http://n8n-supergrok:14502/v1" };
  },
  async reviewVpsSuperGrok({ containerName, networkName, action }) {
    requirePreviewInstall(action);
    return { action, containerName, networkName, ...previewBoundary, installId: null,
      installDirectory: "/docker/n8n-openai-oauth/supergrok",
      operationLockPath: "/docker/n8n-openai-oauth/.supergrok-operation.lock",
      temporaryBuildStatePath: "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx",
      endpoint: "http://n8n-supergrok:14502/v1", publishedPorts: [], existingN8nChanges: [], existingN8nRestarts: 0 };
  },
  async getVpsGrokLoginStatus() { return { state: "idle" }; },
  async discoverVpsGrokModels() { return { status: 200, models: ["grok-4"] }; },
  async getVpsClaudeStatus() {
    return { state: "absent", installation: null, candidate: claudeCompanionPin("amd64") };
  },
  async reviewVpsClaude({ action, containerName, networkName, models = DEFAULT_LOCAL_CLAUDE_MODELS, review }) {
    requirePreviewInstall(action);
    const answers = validateClaudeReview(review);
    return { ...reviewClaudeCompanion({ network: networkName, arch: "amd64", models }),
      action, containerName, networkName, ...previewBoundary, installId: null, review: answers,
      installDirectory: "/docker/n8n-openai-oauth/claude", endpoint: CLAUDE_COMPANION.endpoint,
      operationLockPath: "/docker/n8n-openai-oauth/.claude-operation.lock",
      keepsClaudeLogin: false, expiresAt, existingN8nChanges: [], restarts: 0, publishedPorts: [] };
  },
  async getVpsClaudeAuthStatus() { return { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }; },
  async discoverVpsClaudeModels() { return { models: [...DEFAULT_LOCAL_CLAUDE_MODELS] }; },
  async inspectVpsLocalModel() { return { state: "absent", installId: null, modelId: null, endpoint: null, operation: null }; },
  async reviewVpsLocalModel({ action, containerName, networkName, modelId }) {
    requirePreviewInstall(action);
    const domain = createLocalN8nModelPlan({
      dockerHost: "unix:///var/run/docker.sock", n8nContainerId: previewBoundary.containerId,
      n8nContainerName: containerName, dockerNetworkId: previewBoundary.networkId, networkName, modelId,
      hostResources: { memoryBytes: previewHost.memoryBytes, cpus: previewHost.cpus, diskAvailableBytes: 128 * 1024 ** 3 },
    });
    return { ...domain, action, containerName, networkName, ...previewBoundary, installId: null,
      installDirectory: "/docker/n8n-openai-oauth/local-model",
      operationLockPath: "/docker/n8n-openai-oauth/.local-model-operation.lock",
      temporaryBuildStatePath: "/docker/n8n-openai-oauth/.local-model-operation.lock/buildx",
      sharedRootBootstrap: { directory: "/docker/n8n-openai-oauth",
        markerPath: "/docker/n8n-openai-oauth/.managed-by-relmio-root",
        mayCreateDirectory: true, mayCreateMarker: true, directoryMode: "0700" },
      clearModelCache: false, publishedPorts: [], existingN8nChanges: [], existingN8nRestarts: 0 };
  },
  async getVpsLocalModelOperationStatus() { return { state: "absent", installId: null, modelId: null, endpoint: null, operation: null }; },
  installVpsSuperGrok: refusePreviewWrite,
  changeVpsSuperGrok: refusePreviewWrite,
  applyVpsClaude: refusePreviewWrite,
  installVpsLocalModel: refusePreviewWrite,
  changeVpsLocalModel: refusePreviewWrite,
  installSidecar: refusePreviewWrite,
  installAssistant: refusePreviewWrite,
  };
}

export async function runPreview({
  env = process.env,
  log = console.log,
  open = openBrowser,
  attachReopen = attachBrowserReopenOnEnter,
  startServer = startWizardServer,
  ensureBrowserLaunchRoot = ensureLocalDashboardBrowserLaunchRoot,
  createSessionToken = () => randomBytes(32).toString("base64url"),
  signalTarget = process,
} = {}) {
  if (
    typeof log !== "function" || typeof open !== "function" ||
    typeof attachReopen !== "function" || typeof startServer !== "function" ||
    typeof ensureBrowserLaunchRoot !== "function" ||
    typeof createSessionToken !== "function" ||
    !signalTarget || typeof signalTarget.once !== "function" ||
    typeof signalTarget.removeListener !== "function"
  ) {
    throw new TypeError("The Relmio preview launcher adapter is invalid.");
  }

  const sessionToken = createSessionToken();
  if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new Error("Relmio could not create a strong preview session.");
  }
  const fixture = env.RELMIO_PREVIEW_FIXTURE ?? "connected";
  const services = createPreviewServices(fixture);
  const browserHandoffRoot = await ensureBrowserLaunchRoot({ env });
  let wizard;
  let detachReopen = () => {};
  let closePromise;

  function onSignal() {
    void close().catch(() => {});
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      signalTarget.removeListener("SIGINT", onSignal);
      signalTarget.removeListener("SIGTERM", onSignal);
      detachReopen();
      await wizard?.close();
    })();
    return closePromise;
  }

  try {
    wizard = await startServer({
      sessionToken,
      storageRoot: join(browserHandoffRoot, "siwc-preview"),
      services,
      previewMode: true,
      previewFixture: fixture,
      browserHandoffRoot,
    });
    const prepareLaunch = async () => await wizard.prepareBrowserLaunch("/");
    await open(await prepareLaunch());
    detachReopen = attachReopen({ prepareLaunch, open, write: log });
    if (typeof detachReopen !== "function") {
      throw new TypeError("The Relmio preview reopen adapter is invalid.");
    }
    signalTarget.once("SIGINT", onSignal);
    signalTarget.once("SIGTERM", onSignal);
    log(
      "Sanitized preview opened through a private browser handoff. Live ChatGPT sign-in is disabled. Press Control+C to stop.",
    );
    return Object.freeze({ close });
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runPreview();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
