#!/usr/bin/env node

import { randomBytes } from "node:crypto";

import { attachBrowserReopenOnEnter, openBrowser } from "./browser.js";
import { startWizardServer } from "./web/server.js";

const sessionToken = randomBytes(32).toString("base64url");
const wizard = await startWizardServer({ sessionToken });
const url = `${wizard.origin}/?session=${sessionToken}`;

console.log("");
console.log("Relmio");
console.log("---------");
console.log(`Local wizard: ${url}`);
console.log("");
console.log("This creates a separate sidecar and never restarts n8n.");
console.log("Keep this Terminal window open while using the wizard.");
console.log("Press Control+C to stop.");
console.log("");

openBrowser(url);
const detachBrowserReopen = attachBrowserReopenOnEnter({ url });

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
