import { ASSISTANT_COMPANION_IMAGES, createSearxngSettings } from "./assistant-templates.js";
import { getLocalModelDefinition } from "../local-model/catalog.mjs";

export function modelEnvironment(model, host = "0.0.0.0:11434", modelsPath = "/var/data/models") {
  const selected = getLocalModelDefinition(model?.id);
  if (typeof host !== "string" || !/^(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):11434$/u.test(host) ||
      typeof modelsPath !== "string" || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/u.test(modelsPath)) {
    throw new TypeError("The private model listener or cache path is invalid.");
  }
  return {
    OLLAMA_HOST: host,
    OLLAMA_MODELS: modelsPath,
    OLLAMA_NO_CLOUD: "1",
    OLLAMA_MAX_LOADED_MODELS: "1",
    OLLAMA_NUM_PARALLEL: "1",
    OLLAMA_CONTEXT_LENGTH: String(selected.contextTokens),
    OLLAMA_KEEP_ALIVE: "5m",
  };
}

export function searchEnvironment(host = "0.0.0.0") {
  if (host !== "0.0.0.0" && host !== "::") {
    throw new TypeError("The private search listener is invalid.");
  }
  return { GRANIAN_HOST: host, GRANIAN_PORT: "8080", FORCE_OWNERSHIP: "false" };
}

export function createSearchImageFiles() {
  return [
    { name: "Dockerfile", mediaType: "text/plain", content: `FROM ${ASSISTANT_COMPANION_IMAGES.searxng}
USER root
RUN mkdir -p /etc/searxng /var/cache/searxng && chown -R 977:977 /etc/searxng /var/cache/searxng
COPY --chown=977:977 settings.yml /etc/searxng/settings.yml
COPY --chown=977:977 --chmod=0755 start.sh /usr/local/bin/relmio-searxng-start
USER 977:977
ENTRYPOINT ["/usr/local/bin/relmio-searxng-start"]
` },
    { name: "settings.yml", mediaType: "text/yaml", content: createSearxngSettings() },
    { name: "start.sh", mediaType: "text/plain", content: `#!/bin/sh
set -eu
if [ -z "\${SEARXNG_SECRET:-}" ] || [ "\${#SEARXNG_SECRET}" -lt 32 ]; then
  echo 'SEARXNG_SECRET must be supplied through the provider secret store (32+ characters).' >&2
  exit 1
fi
exec /usr/local/searxng/entrypoint.sh
` },
    { name: ".dockerignore", mediaType: "text/plain", content: "*\n!Dockerfile\n!settings.yml\n!start.sh\n" },
  ];
}
