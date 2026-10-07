import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { attachBrowserReopenOnEnter, openBrowser } from "../src/browser.js";
import { ensureLocalDashboardBrowserLaunchRoot } from "../src/services/local-dashboard-control.js";
import { startWizardServer } from "../src/web/server.js";

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
      dockerVersion: "28.3.2",
      composeVersion: "2.38.2",
      containers: [
        {
          id: "a".repeat(64),
          image: "docker.n8n.io/n8nio/n8n",
          name: "n8n-n8n-1",
          state: "running",
        },
      ],
    };
  },
  async discoverNetworks() {
    return { networks: ["proxy"], recommended: "proxy" };
  },
  async installSidecar() {
    throw new Error("Sanitized preview cannot install a ChatGPT sidecar.");
  },
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
