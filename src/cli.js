#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

import { startWizardServer } from "./web/server.js";

function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "explorer.exe", args: [url] }
        : { file: "xdg-open", args: [url] };

  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.once("error", () => {
    // The URL is also printed, so users can open it manually.
  });
  child.unref();
}

const sessionToken = randomBytes(32).toString("base64url");
const wizard = await startWizardServer({ sessionToken });
const url = `${wizard.origin}/?session=${sessionToken}`;

console.log("");
console.log("PlanRelay");
console.log("---------");
console.log(`Local wizard: ${url}`);
console.log("");
console.log("This creates a separate sidecar and never restarts n8n.");
console.log("Keep this Terminal window open while using the wizard.");
console.log("Press Control+C to stop.");
console.log("");

openBrowser(url);

let closing = false;
async function close() {
  if (closing) {
    return;
  }
  closing = true;
  await wizard.close();
}

process.once("SIGINT", async () => {
  await close();
});
process.once("SIGTERM", async () => {
  await close();
});
