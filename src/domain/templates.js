import { INSTALL_ROOT, validateSiwcRegistrationId, validateSiwcRuntimeId } from "./safety.js";
import { validateSha256Verifier } from "./local-endpoints.js";
import { validateDockerName } from "./validation.js";

export const SIDECAR_HOSTNAME = "n8n-openai-oauth";
export const SIDECAR_IMAGE = "n8n-openai-oauth:local";
export const SIDECAR_ENTRYPOINT = ["node", "/app/gateway/openai-oauth-sidecar.mjs"];

export function createDockerfile() {
  return `FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node services/ ./services/
COPY --chown=node:node gateway/ ./gateway/
COPY --chown=node:node infrastructure/ ./infrastructure/
USER node
ENTRYPOINT ["node", "/app/gateway/openai-oauth-sidecar.mjs"]
`;
}

export function createComposeFile({ networkName, registrationId, runtimeId, tokenSha256 }) {
  const safeNetworkName = validateDockerName(networkName);
  const safeRegistrationId = validateSiwcRegistrationId(registrationId);
  const safeRuntimeId = validateSiwcRuntimeId(runtimeId);
  const safeVerifier = validateSha256Verifier(tokenSha256);

  return `services:
  openai-oauth:
    image: ${SIDECAR_IMAGE}
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    environment:
      N8N_OPENAI_OAUTH_HOME: /home/node/.relmio-siwc
      RELMIO_REGISTRATION_ID: "${safeRegistrationId}"
      RELMIO_RUNTIME_ID: "${safeRuntimeId}"
      RELMIO_GATEWAY_TOKEN_SHA256: "${safeVerifier}"
    volumes:
      - ./siwc:/home/node/.relmio-siwc
    expose:
      - "10531"
    networks:
      n8n-shared:
        aliases:
          - ${SIDECAR_HOSTNAME}
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
      - /home/node/.local:uid=1000,gid=1000,mode=0700
    pids_limit: 128
    mem_limit: 512m
    cpus: 1.0
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - 'fetch("http://127.0.0.1:10531/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    labels:
      io.n8n-openai-oauth.managed: "true"

networks:
  n8n-shared:
    external: true
    name: ${safeNetworkName}
`;
}

export function attestVpsSiwcCompose(config, networkName) {
  const service = config?.services?.["openai-oauth"];
  const env = service?.environment;
  const volume = service?.volumes?.[0];
  if (Object.keys(config?.services ?? {}).length !== 1 ||
      Object.keys(service ?? {}).some(key => ![
        "image", "build", "environment", "volumes", "restart", "init", "read_only",
        "cap_drop", "security_opt", "pids_limit", "mem_limit", "cpus", "tmpfs",
        "networks", "expose", "healthcheck", "labels", "ports", "command", "entrypoint",
      ].includes(key)) ||
      // `docker compose config --format json` always emits these as null; any override is foreign.
      service.command != null || service.entrypoint != null ||
      Object.keys(config?.networks ?? {}).join() !== "n8n-shared" ||
      config.networks["n8n-shared"].name !== validateDockerName(networkName) ||
      config.networks["n8n-shared"].external !== true ||
      service?.image !== SIDECAR_IMAGE ||
      service.build?.context !== INSTALL_ROOT || service.build?.dockerfile !== "Dockerfile" ||
      Object.keys(service.build).some(key => !["context", "dockerfile"].includes(key)) ||
      !env || Object.keys(env).sort().join() !== "N8N_OPENAI_OAUTH_HOME,RELMIO_GATEWAY_TOKEN_SHA256,RELMIO_REGISTRATION_ID,RELMIO_RUNTIME_ID" ||
      env.N8N_OPENAI_OAUTH_HOME !== "/home/node/.relmio-siwc" ||
      env.RELMIO_RUNTIME_ID !== "vps_n8n" ||
      service.volumes?.length !== 1 || volume.type !== "bind" ||
      volume.source !== `${INSTALL_ROOT}/siwc` || volume.target !== "/home/node/.relmio-siwc" ||
      volume.read_only === true ||
      service.restart !== "unless-stopped" || service.init !== true ||
      service.read_only !== true || service.privileged === true ||
      JSON.stringify(service.cap_drop) !== '["ALL"]' ||
      JSON.stringify(service.security_opt) !== '["no-new-privileges:true"]' ||
      service.pids_limit !== 128 || Number(service.mem_limit) !== 536870912 ||
      Number(service.cpus) !== 1 ||
      JSON.stringify(service.tmpfs) !== '["/tmp:size=16m,mode=1777","/home/node/.local:uid=1000,gid=1000,mode=0700"]' ||
      Object.keys(service.networks ?? {}).join() !== "n8n-shared" ||
      JSON.stringify(service.networks["n8n-shared"].aliases) !== '["n8n-openai-oauth"]' ||
      JSON.stringify(service.expose) !== '["10531"]' ||
      !Array.isArray(service.healthcheck?.test) ||
      service.healthcheck.test.join("\n") !== `CMD\nnode\n-e\nfetch("http://127.0.0.1:10531/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))` ||
      service.healthcheck.interval !== "30s" || service.healthcheck.timeout !== "5s" ||
      service.healthcheck.retries !== 3 || service.healthcheck.start_period !== "20s" ||
      service.labels?.["io.n8n-openai-oauth.managed"] !== "true" ||
      (service.ports?.length ?? 0) !== 0) {
    throw new Error("The VPS sidecar execution configuration changed; n8n was not touched.");
  }
  validateSha256Verifier(env.RELMIO_GATEWAY_TOKEN_SHA256);
  return validateSiwcRegistrationId(env.RELMIO_REGISTRATION_ID);
}

export function attestVpsSiwcImage(image, expectedImageId) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(image?.Id) ||
      (expectedImageId && image.Id !== expectedImageId) ||
      image.Config?.User !== "node" || image.Config?.WorkingDir !== "/app" ||
      JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(SIDECAR_ENTRYPOINT) ||
      (image.Config?.Cmd?.length ?? 0) !== 0) {
    throw new Error("The VPS sidecar immutable image or executable changed.");
  }
  return image.Id;
}

export function attestVpsSiwcContainer(container, { service, networkName, networkId, imageId }) {
  const mount = container?.Mounts?.[0];
  const host = container?.HostConfig;
  const config = container?.Config;
  const env = service.environment;
  if (!/^[a-f0-9]{64}$/u.test(container?.Id) || container.Image !== imageId ||
      container.Name !== "/n8n-openai-oauth-openai-oauth-1" ||
      typeof container.State?.Running !== "boolean" || container.State?.Paused !== false ||
      config?.Image !== SIDECAR_IMAGE || config?.User !== "node" ||
      config?.WorkingDir !== "/app" ||
      JSON.stringify(config?.Entrypoint) !== JSON.stringify(SIDECAR_ENTRYPOINT) ||
      (config?.Cmd?.length ?? 0) !== 0 ||
      !Array.isArray(config?.Env) ||
      Object.entries(env).some(([key, value]) =>
        config.Env.filter(entry => entry.startsWith(`${key}=`)).join() !== `${key}=${value}`) ||
      config.Env.some(value => !Object.keys(env).some(key => value.startsWith(`${key}=`)) &&
        !/^(?:PATH|NODE_VERSION|YARN_VERSION)=/u.test(value)) ||
      config?.Labels?.["com.docker.compose.project"] !== "n8n-openai-oauth" ||
      config?.Labels?.["com.docker.compose.service"] !== "openai-oauth" ||
      config?.Labels?.["io.n8n-openai-oauth.managed"] !== "true" ||
      container.Mounts?.length !== 1 || mount.Type !== "bind" || mount.RW !== true ||
      mount.Source !== `${INSTALL_ROOT}/siwc` || mount.Destination !== "/home/node/.relmio-siwc" ||
      !host || host.Privileged !== false || host.ReadonlyRootfs !== true || host.Init !== true ||
      JSON.stringify(host.CapDrop) !== '["ALL"]' || (host.CapAdd?.length ?? 0) !== 0 ||
      JSON.stringify(host.SecurityOpt) !== '["no-new-privileges:true"]' ||
      host.RestartPolicy?.Name !== "unless-stopped" ||
      host.PidsLimit !== 128 || host.Memory !== 536870912 || host.NanoCpus !== 1000000000 ||
      host.Tmpfs?.["/tmp"] !== "size=16m,mode=1777" ||
      host.Tmpfs?.["/home/node/.local"] !== "uid=1000,gid=1000,mode=0700" ||
      Object.keys(host.Tmpfs ?? {}).length !== 2 ||
      (host.PortBindings && Object.keys(host.PortBindings).length > 0) ||
      (host.Devices?.length ?? 0) !== 0 || (host.Binds?.length ?? 0) > 1 ||
      host.PidMode || host.IpcMode === "host" ||
      (host.GroupAdd?.length ?? 0) !== 0 || (host.DeviceRequests?.length ?? 0) !== 0 ||
      (host.DeviceCgroupRules?.length ?? 0) !== 0 ||
      (host.NetworkMode && host.NetworkMode !== networkName) ||
      (host.Runtime && host.Runtime !== "runc") ||
      (host.Sysctls && Object.keys(host.Sysctls).length !== 0) ||
      (host.VolumesFrom?.length ?? 0) !== 0 || (host.ExtraHosts?.length ?? 0) !== 0 ||
      (host.Dns?.length ?? 0) !== 0 || host.UTSMode === "host" ||
      (container.NetworkSettings?.Networks &&
        Object.keys(container.NetworkSettings.Networks).some(name => name !== networkName)) ||
      (container.NetworkSettings?.Networks?.[networkName]?.NetworkID &&
        container.NetworkSettings.Networks[networkName].NetworkID !== networkId) ||
      (container.State.Running && container.NetworkSettings?.Networks?.[networkName]?.NetworkID !== networkId) ||
      Object.values(container.NetworkSettings?.Ports ?? {}).some(value => value !== null)) {
    throw new Error("The owned VPS container, image, storage or execution changed.");
  }
  return Object.freeze({ containerId: container.Id, imageId, running: container.State.Running });
}
