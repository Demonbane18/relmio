import assert from "node:assert/strict";
import test from "node:test";

import {
  validateDockerName, validateHostname, validatePort, validateUsername,
} from "../src/domain/validation.js";
import {
  assertSidecarOnlyCommands, createDeploymentCommands,
  createVerificationCommands, safeSiwcCatalogFailure, validateSiwcAuthBinding, parseManagedFileHashes,
} from "../src/domain/safety.js";
import { attestVpsSiwcCompose, attestVpsSiwcContainer, attestVpsSiwcImage,
  createComposeFile } from "../src/domain/templates.js";

const binding = {
  registrationId: "registration_123456",
  clientId: "oaiapp_account_123",
  generation: "123e4567-e89b-42d3-a456-426614174000",
  ownerHostId: "urn:uuid:123e4567-e89b-42d3-a456-426614174001",
  ownerRuntimeId: "wizard",
};
const options = {
  networkName: "proxy", registrationId: binding.registrationId,
  runtimeId: "vps_n8n", tokenSha256: "a".repeat(64),
};

test("typed deployment identities reject shell syntax and invalid account binding", () => {
  assert.equal(validateHostname("n8n.example.com"), "n8n.example.com");
  assert.equal(validatePort("22"), 22);
  assert.equal(validateUsername("root"), "root");
  assert.equal(validateDockerName("n8n-n8n-1"), "n8n-n8n-1");
  for (const value of ["proxy; docker stop n8n", "$(id)", "name\nsecond-command", "--help"]) {
    assert.throws(() => validateDockerName(value), /invalid/i);
  }
  assert.throws(() => validateSiwcAuthBinding({ ...binding, registrationId: "../auth" }), /invalid/i);
  assert.throws(() => validateSiwcAuthBinding({ ...binding, clientId: "user\nsecret" }), /invalid/i);
  assert.throws(() => validateSiwcAuthBinding({ ...binding, generation: "old-mtime" }), /invalid/i);
  assert.throws(() => validateSiwcAuthBinding({ ...binding, ownerHostId: "urn:uuid:other" }), /invalid/i);
});

test("generated VPS context rejects values that could cross command and account boundaries", () => {
  for (const invalid of [
    { ...options, registrationId: "../../other" },
    { ...options, runtimeId: "x;id" },
    { ...options, tokenSha256: "injected" },
    { ...options, networkName: "proxy; docker rm n8n" },
  ]) assert.throws(() => createComposeFile(invalid));
});

test("only fixed sidecar commands are permitted; protected owner mutation stops its service", () => {
  const commands = [...createDeploymentCommands(), ...Object.values(createVerificationCommands())];
  assert.doesNotThrow(() => assertSidecarOnlyCommands(commands));
  const { stop, host, accept, signOut } = createVerificationCommands();
  assert.notEqual(stop, host);
  assert.notEqual(accept, signOut);
  for (const command of [
    "docker stop n8n-n8n-1", "docker compose -f /docker/n8n/docker-compose.yml up -d",
    "docker compose --project-name n8n-openai-oauth up -d n8n",
  ]) assert.throws(() => assertSidecarOnlyCommands([command]), /sidecar|n8n/i);
});

test("untrusted catalog metadata cannot carry token-like fields into a failure view", () => {
  const accessToken = `sk-${"credential".repeat(5)}`;
  const failure = safeSiwcCatalogFailure({
    status: 401, code: accessToken, param: accessToken, requestId: accessToken,
    recovery: "reauthorize", message: accessToken,
  });
  assert.equal(failure.status, 401);
  assert.equal(failure.recovery, "reauthorize");
  assert.equal(JSON.stringify(failure).includes(accessToken), false);
});

const service = {
  image: "n8n-openai-oauth:local", build: { context: "/docker/n8n-openai-oauth", dockerfile: "Dockerfile" },
  environment: { N8N_OPENAI_OAUTH_HOME: "/home/node/.relmio-siwc",
    RELMIO_REGISTRATION_ID: binding.registrationId, RELMIO_RUNTIME_ID: "vps_n8n",
    RELMIO_GATEWAY_TOKEN_SHA256: "a".repeat(64) },
  volumes: [{ type: "bind", source: "/docker/n8n-openai-oauth/siwc", target: "/home/node/.relmio-siwc" }],
  restart: "unless-stopped", init: true, read_only: true,
  cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
  pids_limit: 128, mem_limit: 536870912, cpus: 1,
  tmpfs: ["/tmp:size=16m,mode=1777", "/home/node/.local:uid=1000,gid=1000,mode=0700"],
  expose: ["10531"], networks: { "n8n-shared": { aliases: ["n8n-openai-oauth"] } },
  labels: { "io.n8n-openai-oauth.managed": "true" },
  healthcheck: { test: ["CMD", "node", "-e",
    'fetch("http://127.0.0.1:10531/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'],
    interval: "30s", timeout: "5s", retries: 3, start_period: "20s" },
};

test("full Compose attestation rejects image, storage and execution changes despite same account strings", () => {
  // Shape emitted by `docker compose config --format json` (Compose 5.x): null command/entrypoint,
  // string memory, empty bind options and IPAM on the external network.
  const rendered = { ...service, command: null, entrypoint: null, mem_limit: "536870912",
    volumes: [{ ...service.volumes[0], bind: {} }] };
  const config = { services: { "openai-oauth": rendered },
    networks: { "n8n-shared": { name: "proxy", ipam: {}, external: true } } };
  assert.equal(attestVpsSiwcCompose(config, "proxy"), binding.registrationId);
  for (const mutation of [
    { image: "foreign:latest" }, { command: ["sh", "-c", "id"] }, { entrypoint: ["sh"] }, { user: "0" },
    { read_only: false }, { cap_add: ["SYS_ADMIN"] }, { privileged: true },
    { volumes: [{ type: "bind", source: "/outside", target: "/home/node/.relmio-siwc" }] },
    { ports: [{ target: 10531, published: "10531" }] },
    { environment: { ...service.environment, NODE_OPTIONS: "--require=/tmp/inject.js" } },
  ]) assert.throws(() => attestVpsSiwcCompose({
    ...config, services: { "openai-oauth": { ...rendered, ...mutation } },
  }, "proxy"));
});

test("immutable executable and container attestation binds actual image and kernel restrictions", () => {
  const imageId = `sha256:${"b".repeat(64)}`;
  const image = { Id: imageId, Config: { User: "node", WorkingDir: "/app",
    Entrypoint: ["node", "/app/gateway/openai-oauth-sidecar.mjs"], Cmd: null } };
  assert.equal(attestVpsSiwcImage(image, imageId), imageId);
  assert.throws(() => attestVpsSiwcImage(image, `sha256:${"c".repeat(64)}`));
  assert.throws(() => attestVpsSiwcImage({ ...image, Config: { ...image.Config, User: "root" } }));
  const container = {
    Id: "c".repeat(64), Image: imageId, Name: "/n8n-openai-oauth-openai-oauth-1",
    State: { Running: true, Paused: false },
    Config: { ...image.Config, Image: "n8n-openai-oauth:local",
      Env: Object.entries(service.environment).map(([key, value]) => `${key}=${value}`),
      Labels: { "com.docker.compose.project": "n8n-openai-oauth",
        "com.docker.compose.service": "openai-oauth", "io.n8n-openai-oauth.managed": "true" } },
    Mounts: [{ Type: "bind", RW: true, Source: "/docker/n8n-openai-oauth/siwc",
      Destination: "/home/node/.relmio-siwc" }],
    HostConfig: { Privileged: false, ReadonlyRootfs: true, Init: true,
      CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      RestartPolicy: { Name: "unless-stopped" }, PidsLimit: 128,
      Memory: 536870912, NanoCpus: 1000000000,
      Tmpfs: { "/tmp": "size=16m,mode=1777", "/home/node/.local": "uid=1000,gid=1000,mode=0700" } },
    NetworkSettings: { Networks: { proxy: { NetworkID: "d".repeat(64) } }, Ports: { "10531/tcp": null } },
  };
  const target = { service, networkName: "proxy", networkId: "d".repeat(64), imageId };
  assert.equal(attestVpsSiwcContainer(container, target).running, true);
  for (const mutation of [
    { Image: `sha256:${"9".repeat(64)}` },
    { HostConfig: { ...container.HostConfig, ReadonlyRootfs: false } },
    { Config: { ...container.Config, Env: [...container.Config.Env, "NODE_OPTIONS=--inspect=0.0.0.0"] } },
    { NetworkSettings: { Networks: { proxy: { NetworkID: "e".repeat(64) } } } },
    { Mounts: [{ ...container.Mounts[0], Source: "/outside" }] },
  ]) assert.throws(() => attestVpsSiwcContainer({ ...container, ...mutation }, target));
});

test("managed hash manifests reject traversal, duplicate identities and oversized output", () => {
  const path = "/docker/n8n-openai-oauth/docker-compose.yml";
  const line = `${"a".repeat(64)}  ${path}\n`;
  assert.deepEqual(parseManagedFileHashes(line), { [path]: "a".repeat(64) });
  for (const invalid of [
    line + line,
    `${"a".repeat(64)}  /outside/compose.yml\n`,
    `${"a".repeat(64)}  /docker/n8n-openai-oauth/../outside\n`,
    "a".repeat(8193),
  ]) assert.throws(() => parseManagedFileHashes(invalid));
});
