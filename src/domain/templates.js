import { validateDockerName } from "./validation.js";

export function createDockerfile() {
  return `FROM node:22-bookworm-slim

RUN npm install --global --ignore-scripts openai-oauth@2.0.0 \\
    && npm cache clean --force

USER node

ENTRYPOINT ["openai-oauth"]
CMD ["--host", "0.0.0.0", "--port", "10531", "--oauth-file", "/home/node/.codex/auth.json"]
`;
}

export function createComposeFile({ networkName }) {
  const safeNetworkName = validateDockerName(networkName);

  return `services:
  openai-oauth:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    volumes:
      - ./auth:/home/node/.codex
    expose:
      - "10531"
    networks:
      n8n-shared:
        aliases:
          - openai-oauth
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    pids_limit: 128
    mem_limit: 512m
    cpus: 1.0
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - fetch("http://127.0.0.1:10531/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))
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
