#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { attachBrowserReopenOnEnter, openBrowser } from "./browser.js";
import {
  ensureLocalDashboardBrowserLaunchRoot,
  inspectLocalDashboardControlPlane,
  readLocalDashboardBrowserUrl,
  runLocalDashboardDaemon,
  startLocalDashboardControlPlane,
  stopLocalDashboardControlPlane,
} from "./services/local-dashboard-control.js";
import { startWizardServer } from "./web/server.js";

const cliPath = fileURLToPath(import.meta.url);
const packageJsonUrl = new URL("../package.json", import.meta.url);

export function isCliEntryPath(entryPath, realpath = realpathSync) {
  if (typeof entryPath !== "string" || entryPath === "") {
    return false;
  }
  try {
    return realpath(entryPath) === realpath(cliPath);
  } catch {
    return false;
  }
}

export function cliMode(argumentsList, { commandName = "relmio" } = {}) {
  if (argumentsList.length === 0) {
    return ["n8n-openai-oauth-setup", "planrelay"].includes(commandName)
      ? "wizard"
      : "local";
  }
  if (argumentsList.length !== 1) {
    throw new Error("Unknown Relmio command. Run relmio --help.");
  }
  switch (argumentsList[0]) {
    case "--version":
    case "-v":
      return "version";
    case "--help":
    case "-h":
      return "help";
    case "local":
      return "local";
    case "vps":
      return "wizard";
    case "assistant":
      return "assistant";
    case "start":
      return "start";
    case "status":
      return "status";
    case "open":
    case "gui":
      return "open";
    case "stop":
      return "stop";
    case "__relmio-dashboard-daemon":
      return "daemon";
    default:
      throw new Error("Unknown Relmio command. Run relmio --help.");
  }
}

function dashboardPath(mode) {
  if (mode === "assistant") return "/assistant";
  if (mode === "wizard") return "/";
  return "/local";
}

async function runForegroundWizard({
  mode,
  env,
  log,
  startServer,
  open,
  attachReopen,
  ensureBrowserLaunchRoot,
}) {
  const sessionToken = randomBytes(32).toString("base64url");
  const browserHandoffRoot = await ensureBrowserLaunchRoot({ env });
  const wizard = await startServer({ sessionToken, browserHandoffRoot });
  const prepareLaunch = async () =>
    await wizard.prepareBrowserLaunch(dashboardPath(mode));

  log("");
  log("Relmio");
  log("---------");
  log("Local wizard: private browser handoff ready");
  log("");
  if (mode === "assistant") {
    log(
      "This creates only the separate AI Assistant companion and never restarts n8n.",
    );
  } else if (mode === "local") {
    log(
      "The dashboard reads local service status without changing anything until you choose and confirm an action.",
    );
  } else {
    log("This creates a separate sidecar and never restarts n8n.");
  }
  log("Keep this Terminal window open while using the wizard.");
  log("Press Control+C to stop.");
  log("");

  await open(await prepareLaunch());
  const detachBrowserReopen = attachReopen({ prepareLaunch, open });

  let closing = false;
  async function close() {
    if (closing) {
      return;
    }
    closing = true;
    detachBrowserReopen();
    await wizard.close();
  }

  process.once("SIGINT", async () => {
    await close();
  });
  process.once("SIGTERM", async () => {
    await close();
  });
  return 0;
}

export function hasInteractiveTerminal({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  return Boolean(input?.isTTY && output?.isTTY);
}

export async function runCli({
  argumentsList = process.argv.slice(2),
  commandName = basename(process.argv[1] ?? "relmio"),
  env = process.env,
  log = console.log,
  readPackage = () => readFile(packageJsonUrl, "utf8"),
  isInteractive = hasInteractiveTerminal,
  startServer = startWizardServer,
  open = openBrowser,
  attachReopen = attachBrowserReopenOnEnter,
  startControlPlane = startLocalDashboardControlPlane,
  inspectControlPlane = inspectLocalDashboardControlPlane,
  stopControlPlane = stopLocalDashboardControlPlane,
  readBrowserUrl = readLocalDashboardBrowserUrl,
  runDaemon = runLocalDashboardDaemon,
  ensureBrowserLaunchRoot = ensureLocalDashboardBrowserLaunchRoot,
} = {}) {
  const mode = cliMode(argumentsList, { commandName });
  if (mode === "version") {
    const packageJson = JSON.parse(await readPackage());
    if (typeof packageJson.version !== "string" || packageJson.version === "") {
      throw new Error("Relmio package metadata does not contain a version.");
    }
    log(packageJson.version);
    return 0;
  }
  if (mode === "help") {
    log("Usage: relmio [local|vps|assistant|start|status|open|stop|--version]");
    log("  local      Open the persistent local services dashboard (default)");
    log("  vps        Open the separate VPS setup wizard");
    log("  assistant  Open the dedicated AI Assistant companion wizard");
    log("  start      Start the local dashboard without opening a browser");
    log("  status     Report whether the exact local dashboard is running");
    log("  open       Start when needed and open the local dashboard");
    log("  stop       Stop only the Relmio dashboard process");
    return 0;
  }

  if (mode === "daemon") {
    const daemon = await runDaemon({ env, startServer });
    if (!daemon?.completion || typeof daemon.completion.then !== "function") {
      throw new Error("Relmio dashboard daemon did not provide a completion signal.");
    }
    await daemon.completion;
    return 0;
  }

  if (mode === "start") {
    const result = await startControlPlane({ env });
    if (result?.state === "started") {
      log("Relmio dashboard started.");
      return 0;
    }
    if (result?.state === "existing") {
      log("Relmio dashboard is already running.");
      return 0;
    }
    throw new Error("Relmio dashboard returned an invalid start result.");
  }

  if (mode === "status") {
    const result = await inspectControlPlane({ env });
    if (result?.state === "healthy") {
      log("Relmio dashboard is running.");
      return 0;
    }
    if (result?.state === "absent") {
      log("Relmio dashboard is not running.");
      return 1;
    }
    if (result?.state === "version-mismatch") {
      log("A dashboard from another Relmio version is running. Run relmio stop, then relmio start.");
      return 1;
    }
    log("Relmio dashboard is not healthy. Run relmio start after inspecting its local state.");
    return 1;
  }

  if (mode === "stop") {
    const result = await stopControlPlane({ env });
    if (result?.state === "stopped") {
      log("Relmio dashboard stopped.");
      return 0;
    }
    if (result?.state === "absent") {
      log("Relmio dashboard is not running.");
      return 0;
    }
    throw new Error("Relmio dashboard returned an invalid stop result.");
  }

  if (!isInteractive()) {
    log(
      "Relmio needs an interactive terminal to open the local wizard. Run relmio from Command Prompt, PowerShell, or another terminal.",
    );
    const packageManagerProbe =
      argumentsList.length === 0 && env?.RELMIO_FOREGROUND_WIZARD !== "1";
    return packageManagerProbe ? 0 : 1;
  }

  if (
    env?.RELMIO_FOREGROUND_WIZARD === "1" &&
    (mode === "local" || mode === "wizard" || mode === "assistant")
  ) {
    return await runForegroundWizard({
      mode,
      env,
      log,
      startServer,
      open,
      attachReopen,
      ensureBrowserLaunchRoot,
    });
  }

  await startControlPlane({ env });
  const privateLaunchUrl = await readBrowserUrl({
    env,
    route: dashboardPath(mode),
  });
  if (!(await open(privateLaunchUrl))) {
    log("Relmio could not open the private dashboard. Fix the default browser and run relmio open again.");
    return 1;
  }
  log("Relmio dashboard opened.");
  return 0;
}

export async function runCliEntrypoint(options = {}) {
  try {
    const exitCode = await runCli(options);
    if (exitCode !== 0) process.exitCode = exitCode;
    return exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return 1;
  }
}

if (isCliEntryPath(process.argv[1])) {
  await runCliEntrypoint();
}
