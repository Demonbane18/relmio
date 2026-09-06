import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  acquireLocalEndpointChangeLock,
  attestLocalGrokBuildInstallation,
  resolveLocalInstallRoot,
} from "./local-installer.js";
import {
  createLocalDockerEnvironment,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";

import {
  acquireLocalN8nSuperGrokChangeLock,
  attestLocalN8nSuperGrokInstallation,
  resolveLocalN8nSuperGrokInstallRoot,
} from "./local-n8n-supergrok-installer.js";

const LOCAL_TARGET = "xai-grok-build";
const N8N_TARGET = "n8n-supergrok-oauth";
const PROJECT_PATTERNS = Object.freeze({
  [LOCAL_TARGET]: /^relmio-xai-grok-build-[a-f0-9]{32}$/u,
  [N8N_TARGET]: /^relmio-n8n-supergrok-oauth-[a-f0-9]{32}$/u,
});
const COMPOSE_FILE = "docker-compose.yml";
const CREDENTIAL_CONTAINER_SUFFIX = "credential-action";
const ACTIONS = Object.freeze({
  "device-auth": "umask 077; exec /usr/bin/timeout --signal=TERM --kill-after=2s 900s grok --no-auto-update login --device-auth",
  logout: "umask 077; exec /usr/bin/timeout --signal=TERM --kill-after=2s 60s grok --no-auto-update logout",
});

function validateRequest({ action, installDirectory, isTTY }) {
  if (!Object.hasOwn(ACTIONS, action)) throw new TypeError("The Grok Build login action is invalid.");
  if (typeof installDirectory !== "string" || !isAbsolute(installDirectory) || installDirectory.includes("\0")) throw new TypeError("The Grok Build install directory is invalid.");
  if (action === "device-auth" && isTTY !== true) throw new Error("Grok Build sign-in requires an interactive terminal.");
  return { action, installDirectory };
}

function validateLifecycle({ signal, loginTimeoutMs, logoutTimeoutMs, terminationGraceMs }) {
  if (!Number.isSafeInteger(loginTimeoutMs) || loginTimeoutMs < 1 || !Number.isSafeInteger(logoutTimeoutMs) || logoutTimeoutMs < 1 || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new TypeError("The Grok Build credential action is invalid.");
  }
  if (signal?.aborted) throw new Error("Grok Build credential action was not completed.");
}

export async function runGrokBuildLogin({ target = LOCAL_TARGET, action, installDirectory, isTTY = process.stdin.isTTY === true, environment = process.env, spawnProcess = spawn, acquireLock, attestInstallation, resolveInstallRoot, signal, loginTimeoutMs = 930_000, logoutTimeoutMs = 90_000, terminationGraceMs = 2_000 } = {}) {
  if (!Object.hasOwn(PROJECT_PATTERNS, target)) throw new TypeError("The SuperGrok target is invalid.");
  const privateN8n = target === N8N_TARGET;
  const serviceName = privateN8n ? "supergrok-oauth" : "grok-build";
  resolveInstallRoot ??= privateN8n ? resolveLocalN8nSuperGrokInstallRoot : resolveLocalInstallRoot;
  attestInstallation ??= privateN8n ? attestLocalN8nSuperGrokInstallation : attestLocalGrokBuildInstallation;
  acquireLock ??= privateN8n
    ? async (_request, options) => acquireLocalN8nSuperGrokChangeLock({ ...options, installRoot: installDirectory })
    : acquireLocalEndpointChangeLock;
  const request = validateRequest({ action, installDirectory, isTTY });
  validateLifecycle({ signal, loginTimeoutMs, logoutTimeoutMs, terminationGraceMs });
  let canonicalInstallDirectory;
  try {
    canonicalInstallDirectory = await resolveInstallRoot({
      target,
      env: environment,
    });
  } catch {
    throw new Error("The managed local Grok Build endpoint could not be attested.");
  }
  if (canonicalInstallDirectory !== request.installDirectory) {
    throw new Error("The managed local Grok Build endpoint could not be attested.");
  }
  if (signal?.aborted) throw new Error("Grok Build credential action was not completed.");
  const release = await acquireLock({ target }, { env: environment });
  let safeToRelease = true;
  try {
    if (signal?.aborted) throw new Error("Grok Build credential action was not completed.");
    let attested;
    try {
      attested = await attestInstallation({ installDirectory: canonicalInstallDirectory });
    } catch {
      throw new Error("The managed local Grok Build endpoint could not be attested.");
    }
    if (
      !attested ||
      attested.installDirectory !== canonicalInstallDirectory ||
      typeof attested.projectName !== "string" ||
      !PROJECT_PATTERNS[target].test(attested.projectName) ||
      (privateN8n && attested.serviceName !== serviceName)
    ) {
      throw new Error("The managed local Grok Build endpoint could not be attested.");
    }
    let dockerHost;
    try { dockerHost = validateLocalDockerHost(attested.dockerHost); } catch { throw new Error("The managed local Grok Build endpoint could not be attested."); }
    let child;
    if (signal?.aborted) throw new Error("Grok Build credential action was not completed.");
    try {
      // The daemon-global name outlives a failed Compose parent. A surviving
      // credential container therefore blocks another action after stale-lock recovery.
      const containerName = `${attested.projectName}-${CREDENTIAL_CONTAINER_SUFFIX}`;
      child = spawnProcess("docker", ["--host", dockerHost, "compose", "--project-name", attested.projectName, "--file", COMPOSE_FILE, "run", "--name", containerName, "--rm", "--no-deps", "--pull", "never", "--entrypoint", "/bin/sh", serviceName, "-c", ACTIONS[request.action]], {
        cwd: canonicalInstallDirectory,
        env: createLocalDockerEnvironment(environment),
        shell: false,
        stdio: "inherit",
        windowsHide: true,
      });
    } catch {
      throw new Error("Grok Build credential action could not start.");
    }
    if (child) safeToRelease = false;
    if (!child || typeof child.once !== "function" || typeof child.kill !== "function") throw new Error("Grok Build credential action could not start.");
    safeToRelease = false;
    const code = await new Promise((resolvePromise) => {
      let settled = false; let terminating = false; let timeout; let killTimeout; let reapTimeout;
      const finish = (value) => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(killTimeout); clearTimeout(reapTimeout); signal?.removeEventListener?.("abort", terminate); resolvePromise(value); };
      const terminate = () => {
        if (settled || terminating) return;
        terminating = true;
        try { child.kill("SIGTERM"); } catch { /* wait for the bounded reap path */ }
        killTimeout = setTimeout(() => {
          if (settled) return;
          try { child.kill("SIGKILL"); } catch { /* wait for the bounded reap path */ }
          reapTimeout = setTimeout(() => finish(null), terminationGraceMs);
        }, terminationGraceMs);
      };
      timeout = setTimeout(
        terminate,
        request.action === "device-auth" ? loginTimeoutMs : logoutTimeoutMs,
      );
      if (signal?.aborted) terminate();
      else signal?.addEventListener?.("abort", terminate, { once: true });
      child.once("error", () => finish(null));
      child.once("close", (value) => {
        // A terminated Compose CLI does not prove its one-off container stopped.
        // Keep the project lock until an operator verifies that uncertain state.
        if (!terminating) safeToRelease = true;
        finish(terminating ? null : value);
      });
    });
    if (code !== 0) throw new Error("Grok Build credential action was not completed.");
    return { action: request.action, success: true };
  } finally {
    if (safeToRelease) await release();
  }
}
