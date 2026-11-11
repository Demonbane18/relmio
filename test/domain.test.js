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
import { assertVpsNetworkSupported, describeVpsNetworkSupport } from "../src/domain/vps-network.js";
import { VPS_FLOWS, buildVpsHostReport } from "../src/domain/vps-host-report.js";
import { assertLocalModelNetworkEligibility } from "../src/domain/local-model-network.js";

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

test("sidecar CLI commands exec only the live sidecar's fixed module; variants are refused", () => {
  const commands = createVerificationCommands();
  for (const [module, subcommands] of Object.entries({
    "codex-images.mjs": { imagesStatus: "status", imagesLoginStart: "login-start", imagesLoginPoll: "login-poll",
      imagesLoginCancel: "login-cancel", imagesSignOut: "sign-out" },
    "model-discovery.mjs": { modelsDiscoveryStatus: "status", modelChecksOn: "checks-on", modelChecksOff: "checks-off",
      usageStatus: "usage" },
  })) for (const [key, subcommand] of Object.entries(subcommands)) {
    const command = commands[key];
    assert.doesNotThrow(() => assertSidecarOnlyCommands([command]));
    assert.ok(command.endsWith(` exec -T openai-oauth node /app/services/${module} ${subcommand}`), key);
    for (const variant of [
      `${command} --force`, `${command}; docker stop n8n`, `${command}\nid`,
      command.replace(" exec -T openai-oauth ", " exec -T n8n "),
      command.replace(" exec -T openai-oauth node ", " run --rm --no-deps -T --entrypoint node openai-oauth "),
      command.replace(`/app/services/${module}`, "/tmp/injected.mjs"),
      `${command.slice(0, -subcommand.length)}login-poll ../auth`,
    ]) assert.throws(() => assertSidecarOnlyCommands([variant]), /sidecar|n8n/i, variant);
  }
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

// Shapes of `docker network inspect` records, reduced to the fields Docker documents.
const networkFixtures = {
  defaultBridge: { Name: "bridge", Driver: "bridge", Scope: "local", Internal: false,
    Options: { "com.docker.network.bridge.default_bridge": "true", "com.docker.network.bridge.enable_icc": "true" } },
  host: { Name: "host", Driver: "host", Scope: "local", Internal: false, Options: {} },
  none: { Name: "none", Driver: "null", Scope: "local", Internal: false, Options: {} },
  internal: { Name: "backend", Driver: "bridge", Scope: "local", Internal: true, Options: {} },
  userBridge: { Name: "n8n_default", Driver: "bridge", Scope: "local", Internal: false, Options: {} },
  overlay: { Name: "swarm_net", Driver: "overlay", Scope: "swarm", Internal: false, Options: null },
  macvlan: { Name: "lan", Driver: "macvlan", Scope: "local", Internal: false, Options: { parent: "eth0" } },
};

test("the shared network check refuses only networks that certainly cannot work", () => {
  for (const [fixture, reason] of [["defaultBridge", "default-bridge"], ["host", "host"], ["none", "none"], ["internal", "internal"]]) {
    const network = networkFixtures[fixture];
    const described = describeVpsNetworkSupport(network);
    assert.deepEqual([described.supported, described.reason], [false, reason]);
    assert.throws(() => assertVpsNetworkSupported(network, { outbound: true }), error => {
      assert.equal(error.code, "vps_network_unsupported");
      assert.equal(error.message, described.message);
      assert.ok(error.message.length <= 240);
      assert.doesNotMatch(error.message, /\/(?:var|docker|home|tmp|opt)\//u);
      return true;
    });
  }
  for (const fixture of ["userBridge", "overlay", "macvlan"]) {
    assert.deepEqual({ ...describeVpsNetworkSupport(networkFixtures[fixture]) }, { supported: true, reason: null, message: null });
    assert.doesNotThrow(() => assertVpsNetworkSupported(networkFixtures[fixture], { outbound: true }));
  }
  // An internal network is refused only where the flow needs to reach the internet.
  assert.doesNotThrow(() => assertVpsNetworkSupported(networkFixtures.internal, { outbound: false }));
  assert.throws(() => assertVpsNetworkSupported(networkFixtures.internal), { code: "vps_network_unsupported" });
  for (const fixture of ["defaultBridge", "host", "none"]) {
    assert.throws(() => assertVpsNetworkSupported(networkFixtures[fixture], { outbound: false }), { code: "vps_network_unsupported" });
  }
  // The default bridge is recognised by either its reserved name or Docker's own option.
  assert.equal(describeVpsNetworkSupport({ Name: "bridge" }).reason, "default-bridge");
  assert.equal(describeVpsNetworkSupport({ ...networkFixtures.defaultBridge, Name: "docker0-renamed" }).reason, "default-bridge");
  // Missing or unreadable facts never refuse a network.
  for (const unknown of [undefined, null, {}, { Name: "custom" }, { Name: "custom", Internal: "true" }, { Name: "custom", Driver: "bridge", Options: "unreadable" }]) {
    assert.equal(describeVpsNetworkSupport(unknown).supported, true);
  }
  // The model's own stricter rule is unchanged: it still wants a local user-defined bridge.
  assert.doesNotThrow(() => assertLocalModelNetworkEligibility(networkFixtures.userBridge));
  assert.throws(() => assertLocalModelNetworkEligibility(networkFixtures.overlay));
});

const reportHost = {
  os: "Ubuntu 24.04.4 LTS", kernel: "6.8.0-117-generic", arch: "x86_64", dockerVersion: "29.5.2", composeVersion: "5.6.1",
  buildxVersion: "0.38.1", memoryBytes: 4095635456, cpus: 2, security: ["apparmor", "seccomp", "cgroupns"],
};
const rootIdentity = { username: "root", loginUid: 0, authentication: "password", privilege: "root" };
const reportRows = (input) => {
  const report = buildVpsHostReport({ identity: rootIdentity, host: reportHost, ...input });
  for (const row of report.rows) {
    assert.deepEqual(Object.keys(row), ["id", "level", "text", "flows"]);
    assert.ok(["pass", "warn", "fail"].includes(row.level), row.id);
    assert.ok(row.text.length > 0 && row.text.length <= 240, `${row.id} is ${row.text.length} characters`);
    assert.ok(row.flows.every(flow => VPS_FLOWS.includes(flow)), row.id);
  }
  assert.equal(new Set(report.rows.map(row => row.id)).size, report.rows.length);
  return Object.fromEntries(report.rows.map(row => [row.id, row]));
};
const levels = rows => Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.level]));

test("the host report passes the tested host and leaves out what is not known", () => {
  const report = buildVpsHostReport({ identity: rootIdentity, host: reportHost });
  assert.equal(report.host, reportHost);
  assert.deepEqual(levels(reportRows({})), {
    login: "pass", os: "pass", cpu: "pass", docker: "pass", compose: "pass", buildx: "pass", resources: "pass", security: "pass",
  });
  // No facts (a connection without a probe result): only what the session itself knows.
  assert.deepEqual(buildVpsHostReport({ identity: rootIdentity }).rows.map(row => row.id), ["login"]);
  assert.equal(buildVpsHostReport({ identity: rootIdentity }).host, null);
  // Missing OS and Buildx reports warn; unknown resource/version values never refuse.
  const unknown = { os: null, kernel: null, arch: null, dockerVersion: null, composeVersion: null, buildxVersion: null, memoryBytes: null, cpus: null, security: null };
  assert.deepEqual(levels(reportRows({ host: unknown })), { login: "pass", os: "warn", buildx: "warn" });
});

test("the host report warns or fails per flow for CPU, Buildx, versions, size and Docker security", () => {
  const rows = host => reportRows({ host: { ...reportHost, ...host } });
  // arm64 is untested everywhere; any other CPU certainly fails only where artifacts are pinned.
  const arm = rows({ arch: "aarch64" }).cpu;
  assert.deepEqual([arm.level, arm.flows], ["warn", []]);
  const other = rows({ arch: "s390x" });
  assert.deepEqual([other.cpu.level, other.cpu.flows], ["fail", ["supergrok", "claude", "local-model"]]);
  assert.deepEqual([other["cpu-untested"].level, other["cpu-untested"].flows], ["warn", ["chatgpt", "assistant"]]);
  // A missing Buildx report is only a warning for the flows that build.
  const noBuildx = rows({ buildxVersion: null }).buildx;
  assert.deepEqual([noBuildx.level, noBuildx.flows], ["warn", ["chatgpt", "supergrok", "claude", "local-model"]]);
  assert.equal(rows({ buildxVersion: undefined }).buildx, undefined);
  // Older engines and other systems are untested, never refused.
  assert.deepEqual(levels(rows({ os: "Debian GNU/Linux 12 (bookworm)", dockerVersion: "26.1.3", composeVersion: "2.24.6+ds1-0ubuntu2" })),
    { login: "pass", os: "warn", cpu: "pass", docker: "warn", compose: "warn", buildx: "pass", resources: "pass", security: "pass" });
  assert.equal(rows({ os: "Ubuntu 24.04 LTS" }).os.level, "pass");
  assert.equal(rows({ os: "Ubuntu 22.04.5 LTS" }).os.level, "warn");
  assert.equal(rows({ dockerVersion: "28.0.1", composeVersion: "2.38.2" }).compose.level, "pass");
  assert.equal(rows({ composeVersion: "2.37.9" }).compose.level, "warn");
  // Size is advisory.
  assert.equal(rows({ cpus: 1 }).resources.level, "warn");
  assert.equal(rows({ memoryBytes: 1_900_000_000 }).resources.level, "warn");
  assert.equal(rows({ memoryBytes: null }).resources.level, "pass");
  assert.equal(rows({ memoryBytes: null, cpus: null }).resources, undefined);
  // SELinux matters to the flows that mount a server folder; user remapping matters to all.
  const secured = rows({ security: ["selinux", "userns", "seccomp"] });
  assert.deepEqual([secured["security-selinux"].level, secured["security-selinux"].flows], ["warn", ["chatgpt", "assistant", "claude"]]);
  assert.deepEqual([secured["security-userns"].level, secured["security-userns"].flows], ["warn", []]);
  assert.equal(secured.security.level, "pass");
  assert.equal(rows({})["security-selinux"], undefined);
});

test("the host report describes the sign-in, the n8n found and the selected network", () => {
  // A sudo session is certain to be refused by the four root-only flows.
  const sudo = reportRows({ identity: { username: "ubuntu", loginUid: 1000, authentication: "agent", privilege: "sudo-n" } }).login;
  assert.deepEqual([sudo.level, sudo.flows], ["fail", ["chatgpt", "assistant", "supergrok", "claude"]]);
  assert.match(sudo.text, /ubuntu/u);

  const container = { id: "a1b2c3d4e5f6", name: "n8n-n8n-1", image: "docker.n8n.io/n8nio/n8n", state: "running" };
  assert.equal(reportRows({ discovery: null }).n8n, undefined, "nothing is said before discovery ran");
  const none = reportRows({ discovery: { containers: [], noneFoundMessage: "No running container from the official n8n image was found." } }).n8n;
  assert.deepEqual([none.level, none.text], ["warn", "No running container from the official n8n image was found."]);
  assert.equal(reportRows({ discovery: { containers: [], noneFoundMessage: "x".repeat(241) } }).n8n.level, "warn");
  assert.match(reportRows({ discovery: { containers: [container] } }).n8n.text, /n8n-n8n-1/u);
  const two = { containers: [container, { ...container, name: "n8n-second-1" }] };
  assert.match(reportRows({ discovery: two }).n8n.text, /2/u);
  assert.match(reportRows({ discovery: two, containerName: "n8n-second-1" }).n8n.text, /n8n-second-1/u);
  // Docker's own image text is shown only when short and plain.
  const odd = reportRows({ discovery: { containers: [{ ...container, name: "n".repeat(128), image: `registry.example/${"i".repeat(200)}\u001b[31m` }] } }).n8n;
  assert.doesNotMatch(odd.text, /registry\.example|\u001b/u);

  const support = Object.fromEntries(Object.values(networkFixtures).map(network => [network.Name, describeVpsNetworkSupport(network)]));
  const networks = { networks: Object.keys(support), support };
  const selected = networkName => reportRows({ discovery: { containers: [container] }, networks, containerName: container.name, networkName });
  assert.equal(selected("n8n_default").network.level, "pass");
  assert.equal(selected("swarm_net").network.level, "pass");
  for (const name of ["bridge", "host", "none"]) {
    assert.deepEqual([selected(name).network.level, selected(name).network.flows], ["fail", []], name);
    assert.equal(selected(name).network.text, support[name].message);
  }
  // Internal: certain failure where the flow must reach the internet; the Assistant only loses web search.
  const internal = selected("backend");
  assert.deepEqual([internal.network.level, internal.network.flows], ["fail", ["chatgpt", "supergrok", "claude", "local-model"]]);
  assert.deepEqual([internal["network-search"].level, internal["network-search"].flows], ["warn", ["assistant"]]);
  // No selection, an unknown selection, or an answer without marks: no refusal is invented.
  assert.equal(selected(null).network, undefined);
  assert.equal(selected("elsewhere").network, undefined);
  assert.equal(reportRows({ networks: { networks: ["proxy"] }, networkName: "proxy" }).network.level, "pass");
});

test("long security option lists stay bounded without hiding SELinux or userns warnings", () => {
  const security = [...Array.from({ length: 14 }, (_, i) => `${i}${"a".repeat(30)}`), "selinux", "userns"];
  const rows = reportRows({ host: { ...reportHost, security } });
  assert.ok(rows.security.text.length <= 240);
  assert.equal(rows["security-selinux"].level, "warn");
  assert.equal(rows["security-userns"].level, "warn");
});
