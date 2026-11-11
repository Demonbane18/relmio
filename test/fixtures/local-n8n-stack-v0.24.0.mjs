// Managed files exactly as Relmio 0.24.0 wrote them for a public ngrok stack.
// The ngrok inspector was published on host loopback and the agent bound to all
// container interfaces. Secrets are fixture values.
export const LEGACY_STACK_INSTALL_ID = "24242424242424242424242424242424";
export const LEGACY_STACK_PROJECT = `relmio-local-n8n-${LEGACY_STACK_INSTALL_ID}`;
export const LEGACY_STACK_N8N_PORT = 5679;
export const LEGACY_STACK_INSPECTOR_PORT = 4041;

export function legacyStackMarker(dockerHost) {
  return {
    schemaVersion: 2,
    kind: "relmio-local-n8n-stack",
    target: "local-n8n-stack",
    installId: LEGACY_STACK_INSTALL_ID,
    projectName: LEGACY_STACK_PROJECT,
    dockerHost,
    publicAccess: "ngrok",
    ngrokHostname: "relmio-legacy.ngrok.app",
    n8nPort: LEGACY_STACK_N8N_PORT,
    ngrokInspectorPort: LEGACY_STACK_INSPECTOR_PORT,
    timezone: "Asia/Manila",
    assistantMode: "disabled",
  };
}

const labels = `      io.relmio.managed: "true"
      io.relmio.target: "local-n8n-stack"
      io.relmio.install: "${LEGACY_STACK_INSTALL_ID}"
      io.relmio.project: "${LEGACY_STACK_PROJECT}"`;

export const LEGACY_STACK_COMPOSE = `services:
  n8n:
    image: docker.io/n8nio/n8n:2.42.5@sha256:f6dc0d15bc9620baf5ba1df834ef81ae4e969f778c09300e567217be88f04a96
    restart: unless-stopped
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
    ports:
      - "127.0.0.1:${LEGACY_STACK_N8N_PORT}:5678"
    volumes:
      - n8n-data:/home/node/.n8n
    networks:
      - edge
    healthcheck:
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
${labels}

  ngrok:
    image: docker.io/ngrok/ngrok:3.39.11-alpine-6a536c4@sha256:187e588f6c4efe3b29cd3eea9fcd768a1afa7342319e3cee9aeb5af6a9cf64fd
    restart: unless-stopped
    command: ["http", "http://n8n:5678", "--url=https://\${NGROK_DOMAIN}", "--traffic-policy-file=/run/secrets/ngrok-traffic-policy.yml"]
    environment:
      NGROK_AUTHTOKEN: \${NGROK_AUTHTOKEN}
      NGROK_CONFIG: /etc/ngrok/ngrok.yml
    ports:
      - "127.0.0.1:${LEGACY_STACK_INSPECTOR_PORT}:4040"
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
${labels}

volumes:
  n8n-data:
    labels:
${labels}

networks:
  edge:
    labels:
${labels}
secrets:
  ngrok-traffic-policy:
    file: ./.runtime/traffic-policy.yml
`;

export const LEGACY_STACK_ENV = `NGROK_AUTHTOKEN="legacy-fixture-authtoken"
N8N_ENCRYPTION_KEY="${"0".repeat(64)}"
NGROK_DOMAIN="relmio-legacy.ngrok.app"
N8N_LOCAL_PORT="${LEGACY_STACK_N8N_PORT}"
NGROK_INSPECTOR_PORT="${LEGACY_STACK_INSPECTOR_PORT}"
GENERIC_TIMEZONE="Asia/Manila"
`;

export const LEGACY_STACK_NGROK_CONFIG = "version: 3\nagent:\n  web_addr: 0.0.0.0:4040\n";

export const LEGACY_STACK_TRAFFIC_POLICY = `on_http_request:
  - actions:
      - type: basic-auth
        config:
          credentials:
            - "legacy:legacy-fixture-password"
`;
