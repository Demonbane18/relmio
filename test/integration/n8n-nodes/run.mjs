// Runs n8n's real nodes in a pinned n8n container against the real Relmio sidecar and a mock upstream.
// Linux with Docker only (CI). Touches only the container, network and volume named after this run.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { checkExecution, createMockUpstream, parseExecuteOutput, startSidecar, WORKFLOWS } from "./harness.mjs";

// The owner's n8n version. The digest is Docker Hub's multi-arch index for this tag.
export const IMAGE = "n8nio/n8n:2.40.7@sha256:ffeb52485f78b1b06c9a832205853cf75da72a07a514c9a27724df85979d6c34";
// The production hostname and port, so credentials and workflows match a real install. The sidecar only answers
// Host values on its private allowlist, which is why host.docker.internal is not used.
const SIDECAR_HOST = "n8n-openai-oauth";
const SIDECAR_PORT = 10531;
const PROJECT = /^relmio-n8n-nodes-[a-f0-9]{8}$/u;
const exec = promisify(execFile);

function assertProject(project) {
  if (!PROJECT.test(project)) throw new Error("Refusing to touch Docker objects outside this harness run.");
  return project;
}

export function containerArgs(project, gateway, harnessDir, encryptionKey) {
  assertProject(project);
  if (!isIPv4(gateway)) throw new Error("The Docker network gateway must be an IPv4 address.");
  if (/[,"\n]/u.test(harnessDir)) throw new Error("The harness path cannot be passed to docker --mount.");
  return ["run", "--detach", "--name", project, "--label", `com.relmio.harness=${project}`, "--network", project,
    "--add-host", `${SIDECAR_HOST}:${gateway}`,
    "--mount", `type=volume,src=${project}-data,dst=/home/node/.n8n`,
    "--mount", `type=bind,src=${harnessDir},dst=/harness,readonly`,
    "--env", `N8N_ENCRYPTION_KEY=${encryptionKey}`, "--env", "N8N_LOG_FORMAT=json", "--env", "N8N_DIAGNOSTICS_ENABLED=false",
    "--env", "N8N_VERSION_NOTIFICATIONS_ENABLED=false", "--env", "N8N_COMMUNITY_PACKAGES_ENABLED=false",
    // No n8n server runs: each CLI command below is its own process, so they never share a database or task broker port.
    "--entrypoint", "node", IMAGE, "-e", "setInterval(() => {}, 1 << 30)"];
}

export function cleanupCommands(project) {
  assertProject(project);
  return [["rm", "--force", "--volumes", project], ["network", "rm", project], ["volume", "rm", "--force", `${project}-data`]];
}

const docker = (args, timeout = 180_000) => exec("docker", args, { timeout, maxBuffer: 64 * 1024 * 1024 });
const tail = (text = "") => text.slice(-4000);

async function main() {
  const project = `relmio-n8n-nodes-${randomBytes(4).toString("hex")}`;
  const upstream = createMockUpstream();
  const results = [];
  let sidecar;
  const cleanup = async () => {
    await sidecar?.close().catch(() => {});
    for (const args of cleanupCommands(project)) await docker(args, 60_000).catch(() => {});
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
  const n8n = (args) => docker(["exec", project, "n8n", ...args]);
  const started = Date.now();
  try {
    await docker(["pull", "--quiet", IMAGE], 600_000);
    await docker(["network", "create", "--label", `com.relmio.harness=${project}`, project]);
    await docker(["volume", "create", "--label", `com.relmio.harness=${project}`, `${project}-data`]);
    const { stdout } = await docker(["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", project]);
    const gateway = stdout.trim();
    await docker(containerArgs(project, gateway, fileURLToPath(new URL("n8n", import.meta.url)), randomBytes(24).toString("hex")));
    // Bound to this run's own bridge address, so only containers on the run's network can reach it.
    sidecar = await startSidecar({ fetchImpl: upstream.fetchImpl, host: gateway, port: SIDECAR_PORT });
    await n8n(["import:credentials", "--input=/harness/credentials.json"]);
    await n8n(["import:workflow", "--separate", "--input=/harness/workflows"]);
    for (const spec of WORKFLOWS) {
      const before = upstream.requests.length;
      const began = Date.now();
      let problems;
      try {
        const { stdout: output } = await n8n(["execute", `--id=${spec.id}`, "--rawOutput"]);
        problems = checkExecution(spec, parseExecuteOutput(output), upstream.requests.slice(before));
      } catch (error) {
        problems = [`n8n execute failed: ${error.message.split("\n")[0]}`];
        process.stderr.write(`${spec.id} output:\n${tail(error.stdout)}\n${tail(error.stderr)}\n`);
      }
      results.push({ id: spec.id, problems, seconds: Math.round((Date.now() - began) / 1000), requests: upstream.requests.length - before });
    }
  } catch (error) {
    results.push({ id: "setup", problems: [error.message.split("\n")[0]], seconds: 0, requests: 0 });
    process.stderr.write(`${tail(error.stdout)}\n${tail(error.stderr)}\n`);
  } finally {
    await cleanup();
  }
  const rows = results.map(({ id, problems, seconds, requests }) => `| ${id} | ${problems.length ? `fail: ${problems.join("; ")}` : "pass"} | ${seconds}s | ${requests} |`);
  const summary = [`n8n 2.40.7 node compatibility (${Math.round((Date.now() - started) / 1000)}s)`, "",
    "| Workflow | Result | Time | Upstream requests |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (results.length !== WORKFLOWS.length || results.some(({ problems }) => problems.length)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
