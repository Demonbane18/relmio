# Changelog

This project follows semantic versioning. Each completed release uses one
version across `package.json`, `package-lock.json`, this file, the Git tag,
and npm. Local checks validate the repository metadata; the publishing guide
checks the registry separately after publication.

## Unreleased

### Added

- Add a curl-based wizard bootstrap for macOS, Linux, WSL, and Git Bash that
  reuses Node.js 22+ or downloads and checksum-verifies a temporary official
  runtime when Node.js is not installed.
- Add an accessible Curl / NPX switcher to the hosted install page so users can
  copy the command that matches their local runtime.

## [0.2.5] - 2026-07-31

### Added

- Add a sanitized successful hosted-chat screenshot and a visible guide to the
  required Sign in with ChatGPT browser extension across the website, GitHub
  README, npm README, and troubleshooting documentation.
- Explain that the hosted extension requirement is separate from the local
  npm wizard callback, where a callback-capturing extension may need to be
  disabled temporarily during sign-in.

## [0.2.4] - 2026-07-31

### Changed

- Add explicit foundation and attribution language for Evan Zhou Dev's
  `openai-oauth` project to the GitHub and npm README explanations.

## [0.2.3] - 2026-07-31

### Added

- Add sanitized GPT-5.6 Sol and Luna AI Agent examples, a model-selector
  compatibility preview, and the completed Docker sidecar state to both the
  GitHub and npm README experiences.

## [0.2.2] - 2026-07-30

### Added

- Add aligned npm keywords and GitHub repository topics for Relmio, GPT model
  variants, n8n, AI agents, and API-key discovery.

## [0.2.1] - 2026-07-30

### Added

- Add the hosted ChatGPT site link to the package metadata and public guides.
- Document the upstream Codex relay model, known limitations, and legal
  responsibilities in both the GitHub and npm README variants.
- Add a command-first install page for the current n8n and Hostinger VPS
  wizard, plus a GitHub control with live package and repository metadata.
- Credit Evan Zhou Dev's `openai-oauth` method on the hosted Relmio page.

### Changed

- Refresh the local setup wizard and hosted chat presentation with the Relmio
  redesign, including clearer progress, copy feedback, responsive layouts, and
  request-state affordances.
- Move the hosted chat and package homepage to
  [relmio.vercel.app](https://relmio.vercel.app/) with Node.js 22 and
  repository-driven preview and production deployments.
- Return ChatGPT OAuth callbacks to the deployment that started sign-in so
  Vercel preview URLs and the production domain both work.
- Run hosted web linting, type checks, builds, tests, and dependency auditing
  in GitHub Actions alongside repository-driven deployments.
- Point package and documentation metadata at the canonical `relmio`
  repository.
- License Relmio under Apache 2.0 and preserve the upstream `openai-oauth`
  attribution in the distributed notice.

### Fixed

- Stream hosted chat responses incrementally through deployment proxies and
  surface safe request errors instead of leaving an empty assistant message.
- Distinguish a ChatGPT hosting-network challenge from an expired OAuth
  session without exposing upstream response bodies or credentials.

## [0.2.0] - 2026-07-29

### Added

- Add a provider-neutral product roadmap with a gated SuperGrok/xAI OAuth
  feasibility track, entitlement checks, and explicit security boundaries.
- Add a trusted-publisher GitHub Actions workflow for short-lived npm
  authentication after the first package publication.

### Changed

- Rename the public product and npm package to Relmio and `relmio` so the
  project can grow beyond its initial n8n setup path.
- Replace the generic plus icon with an original two-lane relay mark and add a
  small brand guide with reusable SVG and source concept assets.
- Publish a concise npm-specific README with absolute image and documentation
  URLs while preserving the full GitHub README and its Mermaid diagrams.
- Build and inspect a deterministic npm tarball so the registry receives the
  npm-specific README instead of the repository README.
- Keep the legacy `n8n-openai-oauth-setup` executable alias and every deployed
  `n8n-openai-oauth` compatibility and safety identifier unchanged.

## [0.1.8] - 2026-07-29

### Changed

- Restore the complete manual sidecar installation path to the README for
  wizard failures, debugging, and contributor reproduction.
- Add plain-English Mermaid diagrams that explain the private sidecar and help
  readers choose between the browser wizard and manual setup.
- Keep the README and standalone manual Docker templates synchronized with
  automated documentation checks.

## [0.1.7] - 2026-07-28

### Changed

- Add prominent workflow-backup reminders to the README, manual guide,
  troubleshooting guide, and browser wizard before VPS access.

## [0.1.6] - 2026-07-28

### Added

- Add a public npm quick-start guide with five sanitized setup screenshots,
  Mermaid architecture diagrams, and a YouTube walkthrough outline.
- Add individual Base URL/API-key copy controls and n8n recipes for OpenAI
  Chat Model, AI Agent, Basic LLM Chain, and HTTP Request nodes.
- Add a release metadata validator that keeps the package, lockfile, changelog,
  and release tag on one version.
- Add GitHub Actions checks with immutable action pins, no persisted checkout
  credential, and the repository's pinned npm `10.9.8` runtime.

### Changed

- Expand troubleshooting for stale wizard sessions, npm versions, local OAuth
  callbacks, SSH failures, Docker networks, real port mappings, and manual
  sidecar collisions.
- Use the wizard-only `~/.n8n-openai-oauth/auth.json` path consistently in the
  manual and maintenance guides.
- Replace pre-publication wording and add the local context file to the shared
  ignore policy.
- Disable npm lifecycle scripts explicitly in every documented and nested
  `npx` invocation.
- Add a prominent workflow-backup reminder before local setup and inside the
  wizard because VPS access remains a real write boundary even with sidecar-only
  commands.
- Separate OpenAI credential fields from OpenAI Chat Model settings and explain
  the Responses API compatibility behavior for Chat Model node version 1.3.
- Polish the public README with a collapsible contents list, clickable project
  links, experimental-use disclaimers, and a contributor guide.
- Document Graphify as an optional local maintainer map while keeping raw graph
  exports out of Git and npm.

### Fixed

- Prevent sanitized preview mode from generating or opening a live OpenAI
  authorization URL.
- Refuse to show the ready screen when the sidecar returns no usable model ID.
- Tag the exact commit that passed CI and was published instead of relying on
  the shell's current `HEAD`.
- Make the sanitized preview follow the production OAuth service contract and
  show the correct private n8n Base URL.
- Fall back to a temporary selected text field when a browser denies the
  modern Clipboard API, so the final credential copy buttons still work.
- Always remove the fallback copy field and restore focus when legacy browser
  clipboard access throws.
- Stop and remove only the named wizard-managed sidecar service when its final
  safety check detects an unexpected host-port publication; report an explicit
  manual cleanup path if that removal cannot be confirmed.
- Clean up the sidecar when publication inspection fails or returns malformed
  metadata, rate-limit install attempts, close the VPS connection after every
  install outcome, and show actionable browser recovery messages.

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

[0.1.7]: https://github.com/Demonbane18/relmio/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Demonbane18/relmio/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Demonbane18/relmio/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Demonbane18/relmio/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Demonbane18/relmio/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Demonbane18/relmio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Demonbane18/relmio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Demonbane18/relmio/releases/tag/v0.1.0
