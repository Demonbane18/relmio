import {
  getLocalN8nStackLabels,
  validateLocalN8nStackMarker,
} from "../../domain/local-n8n-stack.js";

export const LOCAL_N8N_STACK_IMAGES = Object.freeze({
  n8n: "docker.io/n8nio/n8n:2.36.8@sha256:cfe2704ff858395503d42548206c2c99ea351a205e941063a9d9b77b0f404478",
  ngrok: "docker.io/ngrok/ngrok:3.39.11-alpine-6a536c4@sha256:187e588f6c4efe3b29cd3eea9fcd768a1afa7342319e3cee9aeb5af6a9cf64fd",
  sandboxApi: "ghcr.io/n8n-io/n8n-sandbox-service-api:1.1.1@sha256:21672029fee08495e2398cff7fc370ff60ce0e7c461610732bf2f5265cb75704",
  sandboxRunner: "ghcr.io/n8n-io/n8n-sandbox-service-runner-dind:1.1.1@sha256:9de7a8aad7f0d2293716daff40206be60577a59a2c2dae641dd9a425c18bf6fd",
  sandbox: "ghcr.io/n8n-io/n8n-sandbox-service-sandbox:1.1.0@sha256:16f62fb90a4ce61ef74925f62ea76bb11eb2a5598888b7c0651100c7944ed2d8",
  searxng: "ghcr.io/searxng/searxng:2026.8.28-a30b2d474@sha256:addd2cf36efb4b9815a2820a522aef7cce4da0d1c0e4527f6675f5663332fc9b",
});

// The installer verifies these exact services as healthy after Compose reports running.
export const LOCAL_N8N_STACK_HEALTHY_SERVICES = Object.freeze([
  "n8n",
  "ngrok",
  "relmio-sandbox-api",
]);

function yamlScalar(value) {
  return JSON.stringify(value);
}

function composeDotenvLiteral(value) {
  const escaped = String(value).replaceAll(
    /[\\"$]/gu,
    (character) => `\\${character}`,
  );
  return `"${escaped}"`;
}

export function validateLocalN8nStackSecrets({ ngrokAuthtoken, basicAuthUsername, basicAuthPassword }) {
  if (
    typeof ngrokAuthtoken !== "string" ||
    ngrokAuthtoken.length < 8 ||
    ngrokAuthtoken.length > 512 ||
    /[\0\s]/u.test(ngrokAuthtoken)
  ) {
    throw new TypeError(
      "ngrok authtoken must be 8–512 characters with no whitespace. Paste only the token value, not an ngrok command.",
    );
  }
  if (
    typeof basicAuthUsername !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(basicAuthUsername)
  ) {
    throw new TypeError(
      "Basic Auth username must use 1–64 letters, numbers, hyphens, or underscores.",
    );
  }
  if (
    typeof basicAuthPassword !== "string" ||
    basicAuthPassword.length < 12 ||
    basicAuthPassword.length > 512 ||
    /[\0\r\n:]/u.test(basicAuthPassword)
  ) {
    throw new TypeError(
      "Basic Auth password must be 12–512 characters with no colon or line breaks.",
    );
  }
  return { ngrokAuthtoken, basicAuthUsername, basicAuthPassword };
}

export function createNgrokTrafficPolicy({ username, password }) {
  const secrets = validateLocalN8nStackSecrets({
    ngrokAuthtoken: "local-validation-only",
    basicAuthUsername: username,
    basicAuthPassword: password,
  });
  return `on_http_request:
  - actions:
      - type: basic-auth
        config:
          credentials:
            - ${yamlScalar(`${secrets.basicAuthUsername}:${secrets.basicAuthPassword}`)}
`;
}

export function createLocalN8nStackEnv({ installation, secrets, runtimeSecrets }) {
  const marker = validateLocalN8nStackMarker(installation?.marker ?? installation);
  const safeSecrets = validateLocalN8nStackSecrets(secrets);
  if (
    !runtimeSecrets ||
    typeof runtimeSecrets.n8nEncryptionKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(runtimeSecrets.n8nEncryptionKey)
  ) {
    throw new TypeError("Generated local n8n secrets are invalid.");
  }
  const lines = [
    `NGROK_AUTHTOKEN=${composeDotenvLiteral(safeSecrets.ngrokAuthtoken)}`,
    `N8N_ENCRYPTION_KEY=${composeDotenvLiteral(runtimeSecrets.n8nEncryptionKey)}`,
    `NGROK_DOMAIN=${composeDotenvLiteral(marker.ngrokHostname)}`,
    `N8N_LOCAL_PORT=${composeDotenvLiteral(marker.n8nPort)}`,
    `NGROK_INSPECTOR_PORT=${composeDotenvLiteral(marker.ngrokInspectorPort)}`,
    `GENERIC_TIMEZONE=${composeDotenvLiteral(marker.timezone)}`,
  ];
  if (marker.assistantMode !== "disabled") {
    for (const key of ["sandboxApiKey", "runnerRegistrationToken", "runnerApiKey", "searxngSecret"]) {
      if (typeof runtimeSecrets[key] !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(runtimeSecrets[key])) {
        throw new TypeError("Generated local n8n secrets are invalid.");
      }
    }
    lines.push(
      `SANDBOX_API_KEYS=${composeDotenvLiteral(runtimeSecrets.sandboxApiKey)}`,
      `SANDBOX_API_RUNNER_REGISTRATION_TOKEN=${composeDotenvLiteral(runtimeSecrets.runnerRegistrationToken)}`,
      `SANDBOX_API_RUNNER_API_KEY=${composeDotenvLiteral(runtimeSecrets.runnerApiKey)}`,
      `SEARXNG_SECRET=${composeDotenvLiteral(runtimeSecrets.searxngSecret)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function createLocalN8nStackComposeFile({ installation }) {
  const marker = validateLocalN8nStackMarker(installation?.marker ?? installation);
  const labels = getLocalN8nStackLabels(marker);
  const labelLines = Object.entries(labels)
    .map(([key, value]) => `      ${key}: "${value}"`)
    .join("\n");
  const assistant = marker.assistantMode !== "disabled";
  const searxng = marker.assistantMode === "sandbox-with-searxng";
  return `services:
  n8n:
    image: ${LOCAL_N8N_STACK_IMAGES.n8n}
    restart: "no"
    environment:
      N8N_HOST: \${NGROK_DOMAIN}
      N8N_PORT: "5678"
      N8N_PROTOCOL: https
      N8N_WEBHOOK_URL: https://\${NGROK_DOMAIN}/
      N8N_EDITOR_BASE_URL: https://\${NGROK_DOMAIN}/
      N8N_PROXY_HOPS: "1"
      N8N_SECURE_COOKIE: "true"
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true"
      N8N_ENCRYPTION_KEY: \${N8N_ENCRYPTION_KEY}
      N8N_DIAGNOSTICS_ENABLED: "false"
      N8N_VERSION_NOTIFICATIONS_ENABLED: "false"
      N8N_PERSONALIZATION_ENABLED: "false"
      GENERIC_TIMEZONE: \${GENERIC_TIMEZONE}
      TZ: \${GENERIC_TIMEZONE}
${assistant ? `      N8N_ENABLED_MODULES: instance-ai
      N8N_INSTANCE_AI_SANDBOX_ENABLED: "true"
      N8N_INSTANCE_AI_SANDBOX_PROVIDER: n8n-sandbox
      N8N_SANDBOX_SERVICE_URL: http://relmio-sandbox-api:8080
      N8N_SANDBOX_SERVICE_API_KEY: \${SANDBOX_API_KEYS}
${searxng ? "      N8N_INSTANCE_AI_SEARXNG_URL: http://relmio-searxng:8080\n" : ""}` : ""}    ports:
      - "127.0.0.1:${marker.n8nPort}:5678"
    volumes:
      - n8n-data:/home/node/.n8n
    networks:
      - edge
${assistant ? "      - assistant-shared\n" : ""}    healthcheck:
      test: ["CMD", "wget", "--quiet", "--spider", "http://127.0.0.1:5678/healthz/readiness"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    init: true
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m
      - /home/node/.cache:rw,noexec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    labels:
${labelLines}

  ngrok:
    image: ${LOCAL_N8N_STACK_IMAGES.ngrok}
    restart: "no"
    command: ["http", "http://n8n:5678", "--url=https://\${NGROK_DOMAIN}", "--traffic-policy-file=/run/secrets/ngrok-traffic-policy.yml"]
    environment:
      NGROK_AUTHTOKEN: \${NGROK_AUTHTOKEN}
      NGROK_CONFIG: /etc/ngrok/ngrok.yml
    ports:
      - "127.0.0.1:${marker.ngrokInspectorPort}:4040"
    volumes:
      - ./ngrok.yml:/etc/ngrok/ngrok.yml:ro,Z
    secrets:
      - source: ngrok-traffic-policy
        target: ngrok-traffic-policy.yml
        mode: 0444
    networks:
      - edge
    depends_on:
      n8n: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:4040/api/tunnels"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 10s
    init: true
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16m
      - /var/lib/ngrok:rw,noexec,nosuid,nodev,size=1m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    labels:
${labelLines}

${assistant ? `  relmio-sandbox-certs:
    image: ${LOCAL_N8N_STACK_IMAGES.sandboxApi}
    restart: "no"
    user: "0:0"
    command: ["sh", "-c", "bootstrap-mtls.sh --out-dir /tls --api-san relmio-sandbox-api --control-san-prefix relmio-sandbox-runner && chown -R sandbox-api:sandbox-api /tls/api"]
    volumes: ["sandbox-tls:/tls"]
    networks: [assistant-internal]
    labels:
${labelLines}

  relmio-sandbox-api:
    image: ${LOCAL_N8N_STACK_IMAGES.sandboxApi}
    restart: "no"
    depends_on:
      relmio-sandbox-certs: { condition: service_completed_successfully }
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
    volumes: ["sandbox-tls:/tls:ro"]
    networks: [assistant-internal, assistant-shared]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
    labels:
${labelLines}

  relmio-sandbox-runner-1:
    image: ${LOCAL_N8N_STACK_IMAGES.sandboxRunner}
    restart: "no"
    privileged: true
    depends_on:
      relmio-sandbox-api: { condition: service_healthy }
    environment:
      SANDBOX_RUNNER_API_KEYS: \${SANDBOX_API_RUNNER_API_KEY}
      SANDBOX_RUNNER_REGISTRATION_TOKEN: \${SANDBOX_API_RUNNER_REGISTRATION_TOKEN}
      SANDBOX_RUNNER_API_GRPC_ADDR: relmio-sandbox-api:9090
      SANDBOX_RUNNER_HTTP_BASE_URL: http://relmio-sandbox-runner-1:8080
      SANDBOX_RUNNER_CONTROL_GRPC_LISTEN_ADDR: ":9091"
      SANDBOX_RUNNER_CONTROL_GRPC_ADVERTISE_ADDR: relmio-sandbox-runner-1:9091
      SANDBOX_RUNNER_ID: runner-1
      SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE: ${LOCAL_N8N_STACK_IMAGES.sandbox}
      SANDBOX_RUNNER_REGISTRATION_GRPC_CA_FILE: /tls/runner/ca.crt
      SANDBOX_RUNNER_REGISTRATION_GRPC_CERT_FILE: /tls/runner/grpc-client.crt
      SANDBOX_RUNNER_REGISTRATION_GRPC_KEY_FILE: /tls/runner/grpc-client.key
      SANDBOX_RUNNER_REGISTRATION_GRPC_SERVER_NAME: relmio-sandbox-api
      SANDBOX_RUNNER_CONTROL_GRPC_TLS_CERT_FILE: /tls/runner/control-grpc-server.crt
      SANDBOX_RUNNER_CONTROL_GRPC_TLS_KEY_FILE: /tls/runner/control-grpc-server.key
      SANDBOX_RUNNER_CONTROL_GRPC_TLS_CLIENT_CA_FILE: /tls/runner/ca.crt
    volumes: ["sandbox-tls:/tls:ro"]
    networks: [assistant-internal]
    labels:
${labelLines}

${searxng ? `  relmio-searxng:
    image: ${LOCAL_N8N_STACK_IMAGES.searxng}
    restart: "no"
    environment:
      SEARXNG_SECRET: \${SEARXNG_SECRET}
    volumes: ["./.runtime/searxng-settings.yml:/etc/searxng/settings.yml:ro,Z"]
    networks: [assistant-shared]
    labels:
${labelLines}

` : ""}` : ""}volumes:
  n8n-data:
    labels:
${labelLines}
${assistant ? `  sandbox-tls:
    labels:
${labelLines}
` : ""}
networks:
  edge:
    labels:
${labelLines}
${assistant ? `  assistant-shared:
    labels:
${labelLines}
  assistant-internal:
    labels:
${labelLines}
` : ""}secrets:
  ngrok-traffic-policy:
    file: ./.runtime/traffic-policy.yml
`;
}

export function createNgrokConfig() {
  return "version: 3\nagent:\n  web_addr: 0.0.0.0:4040\n";
}

export function createSearxngSettings() {
  return "use_default_settings: true\nsearch:\n  formats:\n    - html\n    - json\n";
}
