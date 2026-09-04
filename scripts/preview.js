import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { attachBrowserReopenOnEnter, openBrowser } from "../src/browser.js";
import { ensureLocalDashboardBrowserLaunchRoot } from "../src/services/local-dashboard-control.js";
import { startWizardServer } from "../src/web/server.js";

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const remote = {
  close() {},
};
const previewCredentialUpdatedAt = new Date().toISOString();

const services = {
  async getAuthStatus() {
    return {
      exists: true,
      path: "/preview/auth.json",
      updatedAt: previewCredentialUpdatedAt,
    };
  },
  async readAuthContents() {
    return Buffer.from('{"preview":true}');
  },
  async scanHostFingerprint() {
    return "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  },
  async connectVerified() {
    return remote;
  },
  async discoverN8n() {
    return {
      dockerVersion: "28.3.2",
      composeVersion: "2.38.2",
      containers: [
        {
          id: "preview",
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
    return {
      baseUrl: "http://n8n-openai-oauth:10531/v1",
      apiKeyPlaceholder: "local-only",
      useResponsesApi: true,
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      deploymentMode: "created",
    };
  },
};

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
      services,
      previewMode: true,
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
