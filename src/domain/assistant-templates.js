import {
  getAssistantContainerNames,
  getAssistantLabels,
  validateAssistantInstallation,
  validateAssistantSearxngSelection,
} from "./assistant.js";
import { validateDockerName } from "./validation.js";

const SANDBOX_SECRET_FIELDS = Object.freeze([
  "sandboxApiKey",
  "runnerRegistrationToken",
  "runnerApiKey",
]);

function createSecret(randomBytes) {
  const value = randomBytes(32);
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new TypeError("The local secret generator is unavailable.");
  }
  return value.toString("base64url");
}

function getRequiredSecretFields(includeSearxng) {
  validateAssistantSearxngSelection(includeSearxng);
  return [...SANDBOX_SECRET_FIELDS, "searxngSecret"];
}

export function createAssistantSecrets({ randomBytes, includeSearxng }) {
  if (typeof randomBytes !== "function") {
    throw new TypeError("A cryptographic random-byte generator is required.");
  }
  const selectedSearxng = validateAssistantSearxngSelection(includeSearxng);
  const secrets = {
    sandboxApiKey: createSecret(randomBytes),
    runnerRegistrationToken: createSecret(randomBytes),
    runnerApiKey: createSecret(randomBytes),
    searxngSecret: createSecret(randomBytes),
  };
  if (new Set(Object.values(secrets)).size !== getRequiredSecretFields(selectedSearxng).length) {
    throw new TypeError("AI Assistant secrets must be independently generated.");
  }
  return secrets;
}

export function createAssistantEnv(secrets, { includeSearxng }) {
  const selectedSearxng = validateAssistantSearxngSelection(includeSearxng);
  const requiredSecretFields = getRequiredSecretFields(selectedSearxng);
  if (
    !secrets ||
    requiredSecretFields.some(
      (field) =>
        typeof secrets[field] !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(secrets[field]),
    )
  ) {
    throw new TypeError("AI Assistant secrets are invalid.");
  }
  const searxngEnv = `SEARXNG_SECRET=${secrets.searxngSecret}
`;
  return `SANDBOX_API_KEYS=${secrets.sandboxApiKey}
SANDBOX_API_RUNNER_REGISTRATION_TOKEN=${secrets.runnerRegistrationToken}
SANDBOX_API_RUNNER_API_KEY=${secrets.runnerApiKey}
${searxngEnv}`;
}

export function createSearxngSettings() {
  return `use_default_settings: true
search:
  formats:
    - html
    - json
`;
}

export function createAssistantComposeFile({ networkName, installation }) {
  const safeNetworkName = validateDockerName(networkName);
  const safeInstallation = validateAssistantInstallation(installation);
  const containerNames = getAssistantContainerNames(safeInstallation);
  const labels = getAssistantLabels(safeInstallation);

  return `volumes:
  sandbox-tls:
    name: ${safeInstallation.projectName}-sandbox-tls
    labels:
      io.relmio.ai-assistant.managed: "${labels["io.relmio.ai-assistant.managed"]}"
      io.relmio.ai-assistant.install-id: "${labels["io.relmio.ai-assistant.install-id"]}"

services:
  relmio-sandbox-certs:
    container_name: ${containerNames.certs}
    image: ghcr.io/n8n-io/n8n-sandbox-service-api:latest
    user: '0:0'
    entrypoint: ['sh', '-c']
    command:
      - >
        bootstrap-mtls.sh --out-dir /tls --api-san relmio-sandbox-api
        --control-san-prefix relmio-sandbox-runner &&
        chown -R sandbox-api:sandbox-api /tls/api
    environment:
      NUM_RUNNERS: '1'
    volumes:
      - sandbox-tls:/tls
    networks:
      - assistant-internal
    labels:
      io.relmio.ai-assistant.managed: "${labels["io.relmio.ai-assistant.managed"]}"
      io.relmio.ai-assistant.install-id: "${labels["io.relmio.ai-assistant.install-id"]}"

  relmio-sandbox-api:
    container_name: ${containerNames.api}
    image: ghcr.io/n8n-io/n8n-sandbox-service-api:latest
    depends_on:
      relmio-sandbox-certs:
        condition: service_completed_successfully
    environment:
      SANDBOX_API_KEYS: \${SANDBOX_API_KEYS}
      SANDBOX_API_RUNNER_REGISTRATION_TOKEN: \${SANDBOX_API_RUNNER_REGISTRATION_TOKEN}
      SANDBOX_API_RUNNER_API_KEY: \${SANDBOX_API_RUNNER_API_KEY}
      SANDBOX_API_GRPC_TLS_CERT_FILE: /tls/api/grpc-server.crt
      SANDBOX_API_GRPC_TLS_KEY_FILE: /tls/api/grpc-server.key
      SANDBOX_API_GRPC_TLS_CLIENT_CA_FILE: /tls/api/ca.crt
      SANDBOX_API_RUNNER_CONTROL_GRPC_TLS_CA_FILE: /tls/api/ca.crt
      SANDBOX_API_RUNNER_CONTROL_GRPC_TLS_CERT_FILE: /tls/api/control-grpc-api-client.crt
      SANDBOX_API_RUNNER_CONTROL_GRPC_TLS_KEY_FILE: /tls/api/control-grpc-api-client.key
      SANDBOX_API_RUNNER_CONTROL_GRPC_TLS_SERVER_NAME: relmio-sandbox-runner-1
    volumes:
      - sandbox-tls:/tls:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
    networks:
      assistant-internal:
      n8n-shared:
        aliases:
          - ${safeInstallation.sandboxAlias}
    labels:
      io.relmio.ai-assistant.managed: "${labels["io.relmio.ai-assistant.managed"]}"
      io.relmio.ai-assistant.install-id: "${labels["io.relmio.ai-assistant.install-id"]}"

  relmio-sandbox-runner-1:
    container_name: ${containerNames.runner}
    image: ghcr.io/n8n-io/n8n-sandbox-service-runner-dind:latest
    privileged: true
    depends_on:
      relmio-sandbox-api:
        condition: service_healthy
    environment:
      SANDBOX_RUNNER_API_KEYS: \${SANDBOX_API_RUNNER_API_KEY}
      SANDBOX_RUNNER_REGISTRATION_TOKEN: \${SANDBOX_API_RUNNER_REGISTRATION_TOKEN}
      SANDBOX_RUNNER_API_GRPC_ADDR: relmio-sandbox-api:9090
      SANDBOX_RUNNER_HTTP_BASE_URL: http://relmio-sandbox-runner-1:8080
      SANDBOX_RUNNER_CONTROL_GRPC_LISTEN_ADDR: ':9091'
      SANDBOX_RUNNER_CONTROL_GRPC_ADVERTISE_ADDR: relmio-sandbox-runner-1:9091
      SANDBOX_RUNNER_ID: runner-1
      SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE: ghcr.io/n8n-io/n8n-sandbox-service-sandbox:latest
      SANDBOX_RUNNER_REGISTRATION_GRPC_CA_FILE: /tls/runner/ca.crt
      SANDBOX_RUNNER_REGISTRATION_GRPC_CERT_FILE: /tls/runner/grpc-client.crt
      SANDBOX_RUNNER_REGISTRATION_GRPC_KEY_FILE: /tls/runner/grpc-client.key
      SANDBOX_RUNNER_REGISTRATION_GRPC_SERVER_NAME: relmio-sandbox-api
      SANDBOX_RUNNER_CONTROL_GRPC_TLS_CERT_FILE: /tls/runner/control-grpc-server.crt
      SANDBOX_RUNNER_CONTROL_GRPC_TLS_KEY_FILE: /tls/runner/control-grpc-server.key
      SANDBOX_RUNNER_CONTROL_GRPC_TLS_CLIENT_CA_FILE: /tls/runner/ca.crt
    volumes:
      - sandbox-tls:/tls:ro
    networks:
      - assistant-internal
    labels:
      io.relmio.ai-assistant.managed: "${labels["io.relmio.ai-assistant.managed"]}"
      io.relmio.ai-assistant.install-id: "${labels["io.relmio.ai-assistant.install-id"]}"

${safeInstallation.includeSearxng ? `  relmio-searxng:
    container_name: ${containerNames.searxng}
    image: ghcr.io/searxng/searxng:latest
    environment:
      SEARXNG_SECRET: \${SEARXNG_SECRET}
    volumes:
      - ./searxng-settings.yml:/etc/searxng/settings.yml:ro
    networks:
      n8n-shared:
        aliases:
          - ${safeInstallation.searxngAlias}
    labels:
      io.relmio.ai-assistant.managed: "${labels["io.relmio.ai-assistant.managed"]}"
      io.relmio.ai-assistant.install-id: "${labels["io.relmio.ai-assistant.install-id"]}"

` : ""}networks:

  assistant-internal:
    name: ${safeInstallation.projectName}-internal
    labels:
      io.relmio.ai-assistant.managed: "${labels["io.relmio.ai-assistant.managed"]}"
      io.relmio.ai-assistant.install-id: "${labels["io.relmio.ai-assistant.install-id"]}"
  n8n-shared:
    external: true
    name: ${safeNetworkName}
`;
}
