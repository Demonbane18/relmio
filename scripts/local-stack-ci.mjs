#!/usr/bin/env node
// CI checks for the one-click local n8n stack.
//   node scripts/local-stack-ci.mjs compose-config
//     Renders the stack files for private, Code Sandbox + SearXNG and ngrok setups and runs this
//     machine's `docker compose config` on them. Needs only the Docker CLI with Compose, so it also
//     runs on Windows runners, which cannot start Linux containers.
//   node scripts/local-stack-ci.mjs live
//     Linux only: installs the private stack with Code Sandbox through the real installer, checks
//     n8n's health, adds an add-on credential to n8n, then removes the stack.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAssistantSecrets } from "../src/domain/assistant-templates.js";
import {
  createLocalN8nStackInstallation,
  createLocalN8nStackPlan,
  LOCAL_N8N_STACK_PUBLIC_CONFIRMATION,
  LOCAL_N8N_STACK_REMOVE_CONFIRMATION,
} from "../src/domain/local-n8n-stack.js";
import {
  getLocalN8nStackStatus,
  installLocalN8nStack,
  removeLocalN8nStack,
} from "../src/services/local-n8n-stack-installer.js";
import { importLocalStackN8nCredential, localStackCredentialId } from "../src/services/local-n8n-stack-credentials.js";
import {
  createLocalN8nStackComposeFile,
  createLocalN8nStackEnv,
  createNgrokConfig,
  createNgrokTrafficPolicy,
  createSearxngSettings,
} from "../src/templates/local-n8n-stack/index.js";

const DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine"
  : "unix:///var/run/docker.sock";

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 26, ...options });
}

async function composeConfig() {
  // `$` and `"` exercise the .env escaping that Compose must read back exactly.
  const ngrokAuthtoken = "ci$token_with$dollars\"and-quote";
  const cases = [
    { publicAccess: "none", assistantMode: "disabled" },
    { publicAccess: "none", assistantMode: "sandbox-with-searxng" },
    { publicAccess: "ngrok", assistantMode: "sandbox" },
  ];
  for (const setup of cases) {
    const ngrok = setup.publicAccess === "ngrok";
    const plan = createLocalN8nStackPlan({
      dockerHost: DOCKER_HOST, publicAccess: setup.publicAccess,
      ngrokHostname: ngrok ? "relmio-ci.ngrok-free.app" : null, n8nPort: 5679,
      ngrokInspectorPort: ngrok ? 4041 : null, timezone: "UTC", assistantMode: setup.assistantMode,
    });
    const installation = createLocalN8nStackInstallation({ plan, randomBytes });
    const secrets = ngrok
      ? { ngrokAuthtoken, basicAuthUsername: "relmio-ci", basicAuthPassword: "long-ci-password-$" }
      : undefined;
    const runtimeSecrets = {
      n8nEncryptionKey: randomBytes(32).toString("hex"),
      ...(setup.assistantMode === "disabled" ? {} : createAssistantSecrets({
        randomBytes, includeSearxng: setup.assistantMode === "sandbox-with-searxng",
      })),
    };
    const directory = await mkdtemp(join(tmpdir(), "relmio stack ci "));
    try {
      await mkdir(join(directory, ".runtime"));
      await writeFile(join(directory, ".env"), createLocalN8nStackEnv({ installation, secrets, runtimeSecrets }));
      await writeFile(join(directory, "docker-compose.yml"), createLocalN8nStackComposeFile({ installation }));
      if (ngrok) {
        await writeFile(join(directory, "ngrok.yml"), createNgrokConfig());
        await writeFile(join(directory, ".runtime", "traffic-policy.yml"),
          createNgrokTrafficPolicy({ username: secrets.basicAuthUsername, password: secrets.basicAuthPassword }));
      }
      if (setup.assistantMode === "sandbox-with-searxng") {
        await writeFile(join(directory, ".runtime", "searxng-settings.yml"), createSearxngSettings());
      }
      const config = JSON.parse(docker([
        "compose", "--project-name", installation.projectName, "--env-file", ".env",
        "--file", "docker-compose.yml", "config", "--format", "json",
      ], { cwd: directory }));
      const services = Object.keys(config.services).sort();
      if (Boolean(config.services.ngrok) !== ngrok) throw new Error(`ngrok service presence is wrong for ${setup.publicAccess}`);
      // `compose config` prints every `$` doubled so its output stays valid Compose; undo that before comparing.
      if (ngrok && config.services.ngrok.environment.NGROK_AUTHTOKEN.replaceAll("$$", "$") !== ngrokAuthtoken) {
        throw new Error("Compose did not read the escaped ngrok token back exactly.");
      }
      const n8nEnv = config.services.n8n.environment;
      if (!ngrok && (n8nEnv.N8N_HOST !== "localhost" || n8nEnv.N8N_SECURE_COOKIE !== "false")) {
        throw new Error("The private stack does not use the localhost n8n settings.");
      }
      const certs = config.services["relmio-sandbox-certs"];
      if (setup.assistantMode !== "disabled" && (certs?.entrypoint?.[0] !== "sh" || certs?.entrypoint?.[1] !== "-c")) {
        throw new Error("The Code Sandbox certificate job must override the image entrypoint.");
      }
      console.log(`compose config ok: ${setup.publicAccess} + ${setup.assistantMode} -> ${services.join(", ")}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function waitForHealthz(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* n8n is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${url} did not become healthy.`);
}

async function live() {
  if (process.platform !== "linux") throw new Error("The live stack check runs on Linux CI only.");
  const homeDirectory = await mkdtemp(join(tmpdir(), "relmio-stack-home-"));
  const plan = createLocalN8nStackPlan({
    dockerHost: DOCKER_HOST, publicAccess: "none", ngrokHostname: null, n8nPort: 5679,
    ngrokInspectorPort: null, timezone: "UTC", assistantMode: "sandbox",
  });
  let installed = false;
  try {
    const result = await installLocalN8nStack({ plan, secrets: undefined, homeDirectory });
    installed = true;
    console.log(`installed ${result.projectName ?? ""}: ${result.localUrl}`);
    await waitForHealthz("http://127.0.0.1:5679/healthz", 60_000);
    const status = await getLocalN8nStackStatus({ homeDirectory });
    if (status.state !== "healthy") throw new Error(`stack status is ${status.state}`);
    const { readFile } = await import("node:fs/promises");
    const marker = JSON.parse(await readFile(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"), "utf8"));
    const credential = await importLocalStackN8nCredential({
      marker, credential: { feature: "local-model", apiKey: "local-only" }, dockerHost: DOCKER_HOST, homeDirectory,
    });
    if (credential.state !== "created") throw new Error(`credential import ${credential.state}`);
    const again = await importLocalStackN8nCredential({
      marker, credential: { feature: "local-model", apiKey: "local-only" }, dockerHost: DOCKER_HOST, homeDirectory,
    });
    if (again.state !== "updated") throw new Error(`second import ${again.state}`);
    const id = localStackCredentialId(marker.installId, "local-model");
    const exported = docker(["exec", `${marker.projectName}-n8n-1`, "n8n", "export:credentials", `--id=${id}`]);
    if (!exported.includes(id) || !exported.includes("Relmio local model")) throw new Error("n8n does not list the imported credential.");
    console.log(`credential in n8n: ${id} Relmio local model`);
  } finally {
    if (installed) {
      await removeLocalN8nStack({ confirmation: LOCAL_N8N_STACK_REMOVE_CONFIRMATION, homeDirectory });
      const left = docker(["ps", "--all", "--quiet", "--filter", "label=io.relmio.target=local-n8n-stack"]).trim();
      if (left) throw new Error("Stack containers remained after removal.");
      console.log("stack removed");
    }
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

const mode = process.argv[2];
if (mode === "compose-config") await composeConfig();
else if (mode === "live") await live();
else throw new Error("Usage: node scripts/local-stack-ci.mjs compose-config|live");
void LOCAL_N8N_STACK_PUBLIC_CONFIRMATION;
