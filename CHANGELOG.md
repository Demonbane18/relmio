# Changelog

## [0.1.5] - 2026-07-28

### Fixed

- Detect a newly approved ChatGPT credential as soon as its complete file is
  available instead of waiting for the OAuth helper process to close.
- Poll the local sign-in state more frequently during the first ten seconds
  so the wizard responds quickly after browser approval.
- Show the local credential's update time and announce when a fresh sign-in
  has been saved.

## [0.1.4] - 2026-07-28

### Fixed

- Run ChatGPT login against a new wizard-only credential file so the bridge
  CLI never needs an interactive terminal to confirm replacement.
- Validate the completed credential before storing it at
  `~/.n8n-openai-oauth/auth.json` with owner-only permissions.
- Stop reusing or overwriting the Codex app credential at
  `~/.codex/auth.json`.
- Open the exact fresh authorization URL returned by the pinned bridge CLI
  and report its completion separately, avoiding stale browser sign-in tabs.
- Verify Docker Compose publisher metadata so an internal-only `10531/tcp`
  declaration is not mistaken for a published VPS host port.
- Explain that browser extensions which intercept the localhost OAuth callback
  must be disabled temporarily during a fresh sign-in.

## [0.1.3] - 2026-07-27

### Fixed

- Let the explicit **Refresh ChatGPT sign-in** action confirm replacement of
  an existing local OAuth credential. Previously, the bridge CLI prompt had
  no input stream, defaulted to “No,” and the wizard reported that sign-in did
  not finish.
- Clarify when the wizard will reuse an existing credential and when to
  refresh it.

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
