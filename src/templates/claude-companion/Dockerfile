# Owner-only Relmio Claude companion: official Claude Code CLI + Relmio adapter.
# Build context: the bundle written by `relmio claude companion prepare`, including its `app/` copy. No published ports.
FROM node:24-bookworm-slim

ARG TARGETARCH
ARG CLAUDE_VERSION=2.1.317
# Official checksums from https://downloads.claude.ai/claude-code-releases/2.1.317/manifest.json
ARG CLAUDE_SHA256_AMD64=eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0
ARG CLAUDE_SHA256_ARM64=563a0d60ad0c223d9415768210997acb0f7134ea51dc3c238e88bc2e18ddeefa

RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) platform=linux-x64; sha="${CLAUDE_SHA256_AMD64}" ;; \
      arm64) platform=linux-arm64; sha="${CLAUDE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    mkdir -p "/opt/claude/${CLAUDE_VERSION}"; \
    curl -fsSL -o "/opt/claude/${CLAUDE_VERSION}/claude" \
      "https://downloads.claude.ai/claude-code-releases/${CLAUDE_VERSION}/${platform}/claude"; \
    echo "${sha}  /opt/claude/${CLAUDE_VERSION}/claude" | sha256sum -c -; \
    chmod 0555 "/opt/claude/${CLAUDE_VERSION}/claude"; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*

RUN useradd --uid 10001 --user-group --create-home --home-dir /home/claude --shell /usr/sbin/nologin claude \
 && mkdir -p /data/account /run/relmio \
 && chown 10001:10001 /data/account && chmod 0700 /data/account \
 && chmod 0755 /data /run/relmio

COPY --chown=root:root app/ /app/
RUN chmod -R a-w /app

USER 10001:10001
WORKDIR /app
ENV RELMIO_CLAUDE_LAUNCH_CONFIG=/run/relmio/launch.json
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD node -e "require('net').connect(14502,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "src/claude/launcher.js"]
