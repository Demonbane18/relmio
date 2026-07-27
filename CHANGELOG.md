# Changelog

## [0.1.2] - 2026-07-27

### Fixed

- Provide a writable `/home/node/.local` tmpfs so the non-root bridge can
  start while the container root filesystem remains read-only.
- Use the collision-resistant Docker hostname `n8n-openai-oauth` so an
  existing manual `openai-oauth` sidecar cannot capture n8n requests.
- Treat a wizard-managed deployment as an update, allowing a fresh local
  ChatGPT sign-in to refresh its OAuth credential safely.

## [0.1.1] - 2026-07-27

### Fixed

- Quote the generated Compose healthcheck command so Docker Compose validates
  it as a string.

## [0.1.0] - 2026-07-27

### Added

- Local browser wizard for installing the OpenAI OAuth sidecar beside a
  self-hosted n8n Docker deployment.
- Read-only n8n and Docker-network discovery.
- Explicit review and confirmation before remote sidecar writes.
- Safety checks that prevent changes to the existing n8n Compose project,
  image, container, or host port mappings.
- `npx`-friendly CLI entry point and beginner documentation.

### Security

- OAuth credentials stay on the local computer until the user approves an
  SFTP upload to the installer-managed sidecar directory.
- SSH host-key confirmation is required before password authentication.
- The sidecar uses an internal-only Docker network endpoint and no published
  VPS port.
