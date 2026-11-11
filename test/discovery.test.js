import assert from "node:assert/strict";
import test from "node:test";

import {
  createInspectContainerImagesCommand,
  createInspectN8nEnabledModulesCommand,
  createInspectNetworkDetailsCommand,
  createInspectNetworksCommand,
  discoverN8n,
  discoverNetworks,
  parseN8nEnabledModulesOutput,
  parseDockerPsOutput,
} from "../src/services/discovery.js";

const VERSION_COMMAND = "docker version --format '{{.Server.Version}}'";
const COMPOSE_COMMAND = "docker compose version --short";
const PS_COMMAND = "docker ps --filter status=running --format '{{json .}}'";
const LABELS_COMMAND = "docker ps --all --format '{{.ID}}|{{.Label \"com.docker.compose.project\"}}|{{.Label \"com.docker.compose.service\"}}'";
const row = (container) => JSON.stringify({ State: "running", ...container });

const dockerPsOutput = [
  row({ ID: "traefik-id", Image: "traefik", Names: "n8n-traefik-1" }),
  row({ ID: "n8n-id", Image: "docker.n8n.io/n8nio/n8n", Names: "n8n-n8n-1" }),
  row({ ID: "other-id", Image: "ghcr.io/example/worker:latest", Names: "worker-1" }),
].join("\n");

// A string is a successful command's output; an object sets the exit code too.
function createFakeRemote(outputs) {
  const commands = [];

  return {
    commands,
    async exec(command) {
      commands.push(command);
      if (!(command in outputs)) {
        throw new Error(`Unexpected command: ${command}`);
      }
      const output = outputs[command];
      return typeof output === "string"
        ? { stdout: output, stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0, ...output };
    },
  };
}

const discover = (ps, { labels = "", ...more } = {}) => discoverN8n(createFakeRemote({
  [VERSION_COMMAND]: "28.3.2\n", [COMPOSE_COMMAND]: "2.38.2\n", [PS_COMMAND]: ps, [LABELS_COMMAND]: labels, ...more,
}));

test("parseDockerPsOutput finds only running official n8n images", () => {
  const containers = parseDockerPsOutput(dockerPsOutput);

  assert.deepEqual(containers, [
    {
      id: "n8n-id",
      image: "docker.n8n.io/n8nio/n8n",
      name: "n8n-n8n-1",
      state: "running",
      composeProject: null,
      n8nSandboxPresent: false,
    },
  ]);
});

test("discoverN8n uses read-only Docker commands", async () => {
  const remote = createFakeRemote({
    [VERSION_COMMAND]: "28.3.2\n",
    [COMPOSE_COMMAND]: "2.38.2\n",
    [PS_COMMAND]: dockerPsOutput,
    [LABELS_COMMAND]: "",
  });

  const result = await discoverN8n(remote);

  assert.equal(result.dockerVersion, "28.3.2");
  assert.equal(result.composeVersion, "2.38.2");
  assert.equal(result.containers[0].name, "n8n-n8n-1");
  assert.equal(Object.hasOwn(result, "noneFoundMessage"), false);
  assert.ok(remote.commands.every((command) => !/\b(stop|restart|rm|exec|run|start|kill|update)\b/.test(command)));
  // Nothing is listed by image ID here, so no container is inspected.
  assert.ok(remote.commands.every((command) => !/\binspect\b/u.test(command)));
});

test("a container Docker lists by image ID is resolved with one inspect of those containers only", async () => {
  const moved = "a1b2c3d4e5f6";
  const foreign = "0f1e2d3c4b5a";
  const gone = "9a8b7c6d5e4f";
  const ps = [
    row({ ID: moved, Image: "3f8a1b2c9d0e", Names: "n8n-n8n-1" }),
    row({ ID: foreign, Image: "sha256:" + "7".repeat(64), Names: "worker-1" }),
    row({ ID: gone, Image: "5e4d3c2b1a09", Names: "n8n-old-1" }),
    row({ ID: "b2c3d4e5f6a7", Image: "n8nio/n8n:1.99.0", Names: "n8n-second-1" }),
  ].join("\n");
  const inspect = createInspectContainerImagesCommand([moved, foreign, gone]);
  assert.equal(inspect, `docker container inspect --format '{{.Id}}|{{.Config.Image}}' ${moved} ${foreign} ${gone}`);
  const remote = createFakeRemote({
    [VERSION_COMMAND]: "28.3.2\n", [COMPOSE_COMMAND]: "2.38.2\n", [PS_COMMAND]: ps, [LABELS_COMMAND]: "",
    // Docker exits non-zero because one container went away; the others still print.
    [inspect]: { code: 1, stdout: `${moved}${"0".repeat(52)}|docker.n8n.io/n8nio/n8n:1.98.2\n${foreign}${"1".repeat(52)}|ghcr.io/example/worker:latest\n` },
  });

  const result = await discoverN8n(remote);

  assert.deepEqual(result.containers.map(({ id, image, name }) => ({ id, image, name })), [
    { id: moved, image: "docker.n8n.io/n8nio/n8n:1.98.2", name: "n8n-n8n-1" },
    { id: "b2c3d4e5f6a7", image: "n8nio/n8n:1.99.0", name: "n8n-second-1" },
  ]);
  assert.deepEqual(remote.commands.filter((command) => /\binspect\b/u.test(command)), [inspect]);
  for (const ids of [[], ["n8n; docker stop n8n"], ["a1b2c3d4e5f6", "--help"], "a1b2c3d4e5f6"]) {
    assert.throws(() => createInspectContainerImagesCommand(ids), /invalid/i);
  }
  // An inspect answer for another container, or with unexpected text, resolves nothing.
  const unresolved = await discover(row({ ID: moved, Image: "3f8a1b2c9d0e", Names: "n8n-n8n-1" }), {
    [createInspectContainerImagesCommand([moved])]: `${foreign}${"0".repeat(52)}|n8nio/n8n\n${moved}${"0".repeat(52)}|n8nio/n8n extra|field\n`,
  });
  assert.deepEqual(unresolved.containers, []);
});

test("the first usable container name is taken and one odd name does not hide the rest", async () => {
  const result = await discover([
    row({ ID: "a1b2c3d4e5f6", Image: "n8nio/n8n", Names: "n8n-main,legacy-alias" }),
    row({ ID: "b2c3d4e5f6a7", Image: "n8nio/n8n", Names: "linked/alias,n8n-linked" }),
    row({ ID: "c3d4e5f6a7b8", Image: "n8nio/n8n", Names: "parent/child" }),
    row({ ID: "d4e5f6a7b8c9", Image: "n8nio/n8n", Names: "n8n-last" }),
  ].join("\n"));

  assert.deepEqual(result.containers.map((container) => container.name), ["n8n-main", "n8n-linked", "n8n-last"]);
});

test("each n8n container reports its Compose project and whether that project runs n8n's sandbox", async () => {
  const result = await discover([
    row({ ID: "a1b2c3d4e5f6", Image: "docker.n8n.io/n8nio/n8n", Names: "n8n-n8n-1" }),
    row({ ID: "b2c3d4e5f6a7", Image: "n8nio/n8n", Names: "solo-n8n-1" }),
    row({ ID: "c3d4e5f6a7b8", Image: "n8nio/n8n", Names: "plain-n8n" }),
    row({ ID: "d4e5f6a7b8c9", Image: "n8nio/n8n", Names: "odd-n8n-1" }),
  ].join("\n"), { labels: [
    "a1b2c3d4e5f6|n8n|n8n",
    // n8n's own sandbox service in the same project; it counts even when stopped.
    "e5f6a7b8c9d0|n8n|sandbox-api",
    "b2c3d4e5f6a7|solo|n8n",
    // A sandbox-api service in another project says nothing about `solo`.
    "f6a7b8c9d0e1|other|sandbox-api",
    "c3d4e5f6a7b8||",
    // Label text that is not a Compose project name is ignored.
    "d4e5f6a7b8c9|Odd Project; id|sandbox-api",
    "not-an-id|n8n|sandbox-api|extra",
  ].join("\n") });

  assert.deepEqual(result.containers.map(({ name, composeProject, n8nSandboxPresent }) => ({ name, composeProject, n8nSandboxPresent })), [
    { name: "n8n-n8n-1", composeProject: "n8n", n8nSandboxPresent: true },
    { name: "solo-n8n-1", composeProject: "solo", n8nSandboxPresent: false },
    { name: "plain-n8n", composeProject: null, n8nSandboxPresent: false },
    { name: "odd-n8n-1", composeProject: null, n8nSandboxPresent: false },
  ]);
});

test("finding no n8n says what was looked for", async () => {
  const result = await discover(row({ ID: "a1b2c3d4e5f6", Image: "ghcr.io/example/custom-n8n", Names: "custom-n8n" }));

  assert.deepEqual(result.containers, []);
  assert.match(result.noneFoundMessage, /running/u);
  assert.match(result.noneFoundMessage, /n8nio\/n8n/u);
  assert.ok(result.noneFoundMessage.length <= 240);
});

test("discoverNetworks validates the container name and prefers proxy", async () => {
  const command = createInspectNetworksCommand("n8n-n8n-1");
  const enabledModulesCommand = createInspectN8nEnabledModulesCommand("n8n-n8n-1");
  const remote = createFakeRemote({
    [command]: "n8n_default\nproxy\n",
    [enabledModulesCommand]: "configured|core, instance-ai, queue\n",
    [createInspectNetworkDetailsCommand(["n8n_default", "proxy"])]: '"n8n_default"|"bridge"|false|""\n"proxy"|"bridge"|false|""\n',
  });

  const result = await discoverNetworks(remote, "n8n-n8n-1");

  assert.deepEqual(result.networks, ["n8n_default", "proxy"]);
  assert.equal(result.recommended, "proxy");
  assert.deepEqual(result.instanceAi, { status: "enabled" });
  assert.deepEqual(result.support, {
    n8n_default: { supported: true, reason: null, message: null },
    proxy: { supported: true, reason: null, message: null },
  });
  assert.ok(remote.commands.every((command) => !/\bdocker exec\b/i.test(command)));
  assert.ok(remote.commands.some((command) => command.startsWith("docker inspect n8n-n8n-1 --format")));
  assert.ok(remote.commands.every((command) => !/json \.Config\.Env/i.test(command)));
  assert.ok(remote.commands.every((command) => /^docker (?:inspect|network inspect) /u.test(command)));
  assert.throws(
    () => createInspectNetworksCommand("n8n-n8n-1; docker stop n8n"),
    /invalid/i,
  );
  for (const names of [[], ["proxy; docker stop n8n"], ["proxy", "--help"], "proxy"]) {
    assert.throws(() => createInspectNetworkDetailsCommand(names), /invalid/i);
  }
});

test("networks that cannot carry a Relmio container are marked and never recommended over one that can", async () => {
  const networks = async (names, details) => discoverNetworks(createFakeRemote({
    [createInspectNetworksCommand("n8n")]: `${names.join("\n")}\n`,
    [createInspectN8nEnabledModulesCommand("n8n")]: "",
    ...(names.length ? { [createInspectNetworkDetailsCommand(names)]: details } : {}),
  }), "n8n");

  const mixed = await networks(["bridge", "backend", "n8n_default", "swarm_net"], [
    '"bridge"|"bridge"|false|"true"',
    '"backend"|"bridge"|true|""',
    '"n8n_default"|"bridge"|false|""',
    '"swarm_net"|"overlay"|false|""',
  ].join("\n"));
  assert.deepEqual(Object.fromEntries(Object.entries(mixed.support).map(([name, entry]) => [name, entry.reason])),
    { bridge: "default-bridge", backend: "internal", n8n_default: null, swarm_net: null });
  assert.equal(mixed.recommended, "n8n_default");
  for (const entry of Object.values(mixed.support)) {
    assert.equal(entry.supported, entry.reason === null);
    assert.equal(typeof entry.message, entry.supported ? "object" : "string");
  }

  // proxy is preferred only while it can be used.
  const internalProxy = await networks(["proxy", "edge"], '"proxy"|"bridge"|true|""\n"edge"|"bridge"|false|""\n');
  assert.equal(internalProxy.recommended, "edge");
  // With nothing usable the first network is still offered, marked.
  const hostOnly = await networks(["host"], '"host"|"host"|false|""\n');
  assert.equal(hostOnly.recommended, "host");
  assert.equal(hostOnly.support.host.reason, "host");

  // A failed or unreadable inspect leaves networks unmarked, except Docker's predefined names.
  for (const details of [{ code: 1, stdout: "private-daemon-error" }, "not|the|expected|shape\n{broken", '"elsewhere"|"bridge"|true|""\n']) {
    const unknown = await networks(["bridge", "none", "backend"], details);
    assert.deepEqual(Object.fromEntries(Object.entries(unknown.support).map(([name, entry]) => [name, entry.reason])),
      { bridge: "default-bridge", none: "none", backend: null });
    assert.equal(unknown.recommended, "backend");
    assert.equal(JSON.stringify(unknown).includes("private-daemon-error"), false);
  }

  const empty = await networks([], "");
  assert.deepEqual([empty.networks, empty.recommended, empty.support], [[], null, {}]);
});

test("N8N_ENABLED_MODULES parsing returns an allowlisted prerequisite status only", () => {
  assert.deepEqual(parseN8nEnabledModulesOutput(""), { status: "missing" });
  assert.deepEqual(
    parseN8nEnabledModulesOutput("configured|community-nodes, queue\n"),
    { status: "configured" },
  );
  assert.deepEqual(
    parseN8nEnabledModulesOutput("configured|community-nodes,  instance-ai  , queue\n"),
    { status: "enabled" },
  );
  for (const modules of [
    "core instance-ai",
    "community-nodes, instance-ai queue",
    "instance-ai-preview, queue",
    "queue, instance-ai-extra",
  ]) {
    assert.deepEqual(
      parseN8nEnabledModulesOutput(`configured|${modules}\n`),
      { status: "configured" },
    );
  }
  const status = parseN8nEnabledModulesOutput("configured|instance-ai, unexpected-secret-value\n");
  assert.deepEqual(status, { status: "enabled" });
  assert.equal(JSON.stringify(status).includes("unexpected-secret-value"), false);
  assert.throws(
    () => parseN8nEnabledModulesOutput("configured|instance-ai\nconfigured|queue\n"),
    /could not be verified/i,
  );
});

test("discovery reports malformed Docker output without exposing raw data", () => {
  assert.throws(
    () => parseDockerPsOutput("{not-json}"),
    /could not understand Docker/i,
  );
});

test("image-ID discovery does not silently truncate the running container list", async () => {
  const ids = Array.from({ length: 40 }, (_, index) => index.toString(16).padStart(12, "0"));
  const ps = ids.map((id, index) => row({ ID: id, Image: "f".repeat(12), Names: `n8n-${index}` })).join("\n");
  const result = await discover(ps, {
    [createInspectContainerImagesCommand(ids)]: ids.map(id => `${id}${"0".repeat(52)}|n8nio/n8n`).join("\n"),
  });
  assert.equal(result.containers.length, ids.length);
  assert.deepEqual(result.containers.map(container => container.id), ids);
  assert.deepEqual(parseDockerPsOutput(row({ ID: ids[0], Image: "n8nio/n8n" })), []);
});
