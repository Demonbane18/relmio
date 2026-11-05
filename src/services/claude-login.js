import { spawn } from "node:child_process";
import { createLocalDockerEnvironment, validateLocalDockerHost } from "../infrastructure/local-process.js";
import { CANDIDATE_VERSION } from "../claude/launcher.js";
import {
  resolveLocalN8nClaudeInstallRoot, acquireLocalN8nClaudeChangeLock,
  attestLocalN8nClaudeInstallation, getLocalN8nClaudeAuthStatus,
} from "./local-n8n-claude-installer.js";

export async function runClaudeCompanionLogin({
  isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true,
  environment = process.env, spawnProcess = spawn,
  resolveInstallRoot = resolveLocalN8nClaudeInstallRoot,
  acquireLock = acquireLocalN8nClaudeChangeLock,
  attestInstallation = attestLocalN8nClaudeInstallation,
  readAuthStatus = getLocalN8nClaudeAuthStatus,
} = {}) {
  if (isTTY !== true) throw new Error("Claude companion sign-in requires an interactive terminal.");
  const installDirectory = await resolveInstallRoot({ env: environment });
  const release = await acquireLock({ installRoot: installDirectory });
  let safeToRelease = true;
  try {
    const attested = await attestInstallation({ installDirectory }, { env: environment });
    if (attested?.installDirectory !== installDirectory || attested.projectName !== "relmio-claude" ||
        attested.serviceName !== "relmio-claude" || !/^[a-f0-9]{64}$/u.test(attested.containerId ?? "")) {
      throw new Error("The managed local Claude companion could not be attested.");
    }
    const dockerHost = validateLocalDockerHost(attested.dockerHost);
    let child;
    try {
      child = spawnProcess("docker", ["--host", dockerHost, "exec", "-it", "-w", "/data/account/empty", "relmio-claude",
        "env", "-i", `TERM=${/^[A-Za-z0-9_.+-]{1,64}$/u.test(environment.TERM ?? "") ? environment.TERM : "xterm-256color"}`,
        "HOME=/home/claude", "USER=claude", "LOGNAME=claude", "CLAUDE_CONFIG_DIR=/data/account/config",
        "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR=/tmp", "/usr/bin/timeout", "--signal=TERM", "--kill-after=2s", "900s",
        `/opt/claude/${CANDIDATE_VERSION}/claude`, "auth", "login"], {
        cwd: installDirectory, env: createLocalDockerEnvironment(environment), shell: false,
        stdio: "inherit", windowsHide: true,
      });
    } catch { throw new Error("Claude companion sign-in could not start."); }
    if (!child || typeof child.once !== "function") throw new Error("Claude companion sign-in could not start.");
    safeToRelease = false;
    const code = await new Promise(resolve => {
      child.once("error", () => resolve(null));
      child.once("close", resolve);
    });
    safeToRelease = Number.isInteger(code);
    if (code !== 0) throw new Error("Claude companion sign-in was not completed.");
    const status = await readAuthStatus({}, { env: environment });
    if (typeof status?.loggedIn !== "boolean" || ![status.authMethod, status.subscriptionType].every(value =>
      value === null || (typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(value)))) {
      throw new Error("Claude companion sign-in status is invalid.");
    }
    return { loggedIn: status.loggedIn, authMethod: status.authMethod, subscriptionType: status.subscriptionType };
  } finally { if (safeToRelease) await release(); }
}
