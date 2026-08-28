#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { attachBrowserReopenOnEnter, openBrowser } from "./browser.js";
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

export function cliMode(argumentsList) {
  if (
    argumentsList.length === 1 &&
    (argumentsList[0] === "--version" || argumentsList[0] === "-v")
  ) {
    return "version";
  }
  return argumentsList.length === 1 && argumentsList[0] === "assistant"
    ? "assistant"
    : "wizard";
}

export function hasInteractiveTerminal({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  return Boolean(input?.isTTY && output?.isTTY);
}

export async function runCli({
  argumentsList = process.argv.slice(2),
  log = console.log,
  readPackage = () => readFile(packageJsonUrl, "utf8"),
  isInteractive = hasInteractiveTerminal,
  startServer = startWizardServer,
  open = openBrowser,
  attachReopen = attachBrowserReopenOnEnter,
} = {}) {
  const mode = cliMode(argumentsList);
  if (mode === "version") {
    const packageJson = JSON.parse(await readPackage());
    if (typeof packageJson.version !== "string" || packageJson.version === "") {
      throw new Error("Relmio package metadata does not contain a version.");
    }
    log(packageJson.version);
    return;
  }

  if (!isInteractive()) {
    log(
      "Relmio needs an interactive terminal to open the local wizard. Run relmio from Command Prompt, PowerShell, or another terminal.",
    );
    return;
  }

  const sessionToken = randomBytes(32).toString("base64url");
  const wizard = await startServer({ sessionToken });
  const url = `${wizard.origin}${mode === "assistant" ? "/assistant" : "/"}?session=${sessionToken}`;

  log("");
  log("Relmio");
  log("---------");
  log(`Local wizard: ${url}`);
  log("");
  log(
    mode === "assistant"
      ? "This creates only the separate AI Assistant companion and never restarts n8n."
      : "This creates a separate sidecar and never restarts n8n.",
  );
  log("Keep this Terminal window open while using the wizard.");
  log("Press Control+C to stop.");
  log("");

  open(url);
  const detachBrowserReopen = attachReopen({ url });

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
}

if (isCliEntryPath(process.argv[1])) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
