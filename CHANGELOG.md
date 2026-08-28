# Changelog

This project follows semantic versioning. Each completed release uses one
version across `package.json`, `package-lock.json`, this file, the Git tag,
and npm. Local checks validate the repository metadata; the publishing guide
checks the registry separately after publication.

## Unreleased

### Added

- Add `relmio assistant`, a dedicated local wizard and isolated companion
  Compose plan for n8n AI Assistant's self-hosted sandbox and optional SearXNG
  web search.

### Security

- Keep the privileged Docker-in-Docker runner separate from the selected n8n
  network, publish no companion host ports, generate and redact independent
  sandbox secrets, attest ownership-bound random Compose identities and network
  aliases, serialize VPS-sidecar and assistant mutations under one single-use
  plan lock, and retain the strict no-n8n-mutation boundary.

## [0.8.1] - 2026-08-26

### Changed

- Adopt the Gateway Android logo across the GitHub and npm READMEs, hosted
  site, and local wizard, and stop publishing the retired Harbor Gate mark.
- Refresh the Open Graph and social-preview card with the Gateway Android while
  preserving the Relmio relay message and visual flow.
- Add a prominent Legal warning against bypassing rate limits, restrictions, or
  safeguards.

## [0.8.0] - 2026-08-26

### Added

- Let trusted local backends and development servers receive Chat Adapter turns
  as opt-in Server-Sent Events, with progress and text deltas followed by one
  explicit terminal outcome so a completed response is distinguishable from a
  redacted failure.
- Let the setup-token-protected local wizard tester show that incremental
  response flow after a short-lived encrypted credential handoff, without a
  direct browser-to-adapter request.
- Refresh the hosted chat experience and local installer presentation, and
  adopt the Harbor Gate abstract mark across Relmio surfaces.

### Changed

- Document the streaming contract, local tester behavior, and its limits in the
  canonical endpoint/reference guides and generated hosted documentation.

### Security

- Keep the Chat Adapter experimental, loopback-only, and limited to trusted
  local backends or development servers; it rejects browser origins and is not
  an OpenAI `/v1` endpoint or a substitute for an OpenAI Platform API key.

## [0.7.0] - 2026-08-16

### Added

- Add an encrypted in-wizard tester for the experimental Chat Adapter, plus
  safe sample Chat Adapter and Codex App Server commands for local testing.
- Add generated hosted guides for getting started, local endpoints, VPS and
  n8n, troubleshooting, FAQ, security, and reference information.

### Changed

- Synchronize concise root and npm READMEs around product, installation,
  security, and common-problem overviews that link to hosted guides.
- Fact-check ChatGPT/Codex token-refresh guidance across documentation: tokens
  refresh during active use, the official documentation specifies no fixed
  10-day lifetime, and the provider credential remains distinct from Relmio's
  rotatable client capability.

### Security

- Limit tester destinations to literal loopback HTTP addresses, retain private
  keys only in memory for a bounded lifetime, encrypt entered credentials
  before they cross the browser boundary, require POST after a completed Chat
  Adapter install, keep sample bearer values out of process arguments, and
  erase or abort sessions when forgotten, rotated, or shut down.

## [0.6.0] - 2026-08-15

### Added

- Add an experimental loopback-only Codex Chat Adapter for trusted local
  backends and development servers, with bearer authentication, multi-turn
  conversation IDs, strict resource bounds, and a small Relmio-specific
  `POST /chat` contract.

### Changed

- Make Codex device sign-in target-aware so the experimental Relmio `/chat`
  adapter and native App Server retain isolated, persistent ChatGPT credentials;
  a Platform API key powers neither target and remains reserved for the generic
  OpenAI-compatible `/v1` endpoint.

### Security

- Reject browser-origin adapter requests, keep the adapter separate from
  Platform-key-backed generic OpenAI-compatible `/v1` semantics, explicitly deny
  model turns access to the private Codex credential store, run chat turns
  read-only without network access, and preserve loopback-only publication plus
  credential rotation.

## [0.5.0] - 2026-08-15

### Added

- Add a **Rotate client credential** action for installed local endpoints that
  shows the replacement capability before activation and preserves the upstream
  Platform key or Codex credential/workspace volumes.

### Changed

- Keep System, Light, and Dark appearance controls plus Ko-fi, GitHub stars, and
  the current package version available throughout the local install wizard.

### Fixed

- Install operating-system CA certificates in the isolated Codex image so the
  official ChatGPT device-code sign-in can establish its trusted TLS connection.
- Wrap local safety and error notifications instead of clipping longer text.

### Security

- Verify the generated Codex capability with a strict authenticated WebSocket
  upgrade before reporting installation or rotation success.
- Serialize installation, sign-in, restart, and credential rotation across
  Relmio processes, with attested stale-lock recovery and fail-closed rollback
  that restores the prior verifier and re-attests endpoint readiness.

## [0.4.1] - 2026-08-14

### Changed

- Add a manual **Stop sign-in** action while a fresh ChatGPT login is pending,
  then detect and reject results from superseded wizard attempts.

### Fixed

- Terminate the OAuth helper process tree when sign-in is stopped or Relmio
  exits, preventing a rejected or abandoned attempt from continuing to hold
  the `localhost:1455` callback port.

### Security

- Fail closed when OAuth process cleanup or credential promotion cannot be
  confirmed, blocking another login until Relmio restarts instead of risking
  an ambiguous helper or credential state.

## [0.4.0] - 2026-08-13

### Added

- Add a local Docker wizard for private compatible clients through a
  Platform-key-backed OpenAI-compatible `/v1` endpoint, plus a separate
  official experimental Codex App Server target for trusted ChatGPT-sign-in
  clients.
- Add compact Ko-fi support links to the hosted navigation and public package
  guides.

### Changed

- Make the local credential boundary explicit across the product: a Platform
  API key powers compatible `/v1` requests, while ChatGPT sign-in powers only
  the experimental Codex App Server protocol.

### Fixed

- Keep the controlling terminal attached when the macOS/Linux installer is
  piped through `sh`, so the Relmio wizard can open its interactive browser
  setup flow.
- Install Homebrew dependencies in their required order during release-candidate
  validation.

### Security

- Bind local endpoints exclusively to loopback, require one-time Relmio
  capabilities, pin every managed operation to an attested local Docker
  socket, and isolate provider credentials in target-specific containers.
- Restrict the managed Codex endpoint to the ChatGPT login method.

## [0.3.1] - 2026-08-10

### Changed

- Make the browser wizard beginner-friendly with a modern fixed-viewport
  layout: all five active steps fit without document scrolling on common
  1280x720 laptops, while progress and safety context stay persistent beside
  the active task.
- Keep narrow-phone documents fixed to the viewport and contain unavoidable
  long-form overflow within the active task panel instead of the page.
- Expand the GitHub and npm walkthroughs with a hosted-install selector and
  packaged, sanitized screenshots that document the current n8n workflow.

### Security

- Restore a clean hosted-web dependency audit by pinning patched `js-yaml`
  and `nanoid` releases and using the compatible `vinext` release that does
  not include the currently vulnerable `image-size` parser.

## [0.3.0] - 2026-08-05

### Added

- Add a copy-ready n8n HTTP Request recipe to the local wizard, including the
  private Chat Completions URL, Generic Credential Type → Bearer Auth fields,
  the harmless `local-only` bearer placeholder, JSON headers, the structured
  response-format body, and a full recipe copy action.
- Add the same structured `gpt-5.6-sol` example and importable cURL recipe to
  the GitHub README, npm README, and n8n configuration guide.
- Add a repository-local changelog skill that standardizes Relmio's patch,
  pre-1.0 feature, and stable major release numbering and metadata checks.

### Changed

- Treat `0.3.0` as Relmio's major feature release within the pre-1.0 series;
  it consolidates the key improvements shipped from v0.2.10 through v0.2.14:
  resilient Windows OAuth/bootstrap flows, native Command Prompt installation,
  compact accessible wizard recipes, verified Homebrew/package-manager
  preparation, and release-time package checks.
- Keep the HTTP Request body aligned with n8n's `messages` format by targeting
  `/v1/chat/completions`; the separate OpenAI Chat Model guidance continues to
  support the Responses API where that node exposes the switch.

## [0.2.15] - 2026-08-05

### Fixed

- Exit cleanly when WinGet or another non-interactive validator probes the
  portable command without arguments, while keeping the browser wizard for
  interactive Command Prompt and PowerShell sessions.
- Add a redirected-stdio portable smoke test so future WinGet candidates cannot
  regress into a never-ending default launch.
- Exclude local npm cache directories from portable release archives.

## [0.2.14] - 2026-08-04

### Added

- Add staged Homebrew formula and WinGet portable-package generation with
  x64/ARM64 manifests, installed-command smoke tests, and review-only CI
  artifacts for package-manager publication.
- Add `relmio --version` and `relmio -v` for noninteractive installer and
  package-manager verification.

### Changed

- Report Homebrew and WinGet publication status in the hosted install page and
  documentation, while keeping unapproved commands out of the primary picker.

### Fixed

- Replace the hosted Command Prompt installer route's PowerShell launch with a
  PowerShell-free, non-admin native batch bootstrap that reuses Node.js 22+
  when available or verifies a pinned official Windows runtime before use.
- Keep downloaded checksum-manifest text out of CMD evaluation and use reviewed
  Node.js 22.23.2 x64/ARM64 digests embedded in the release.
- Download the CMD bootstrap to a collision-resistant temporary name without
  overwriting an existing `install.cmd`, then clean it after execution.
- Show deterministic download, checksum-verification, and extraction stages in
  every bootstrap so temporary Node.js runtime setup does not appear stalled.

## [0.2.13] - 2026-08-04

### Changed

- Compact the local setup wizard so its active step stays near the top, move
  safety and status notices into dismissible toasts, and collapse the optional
  AI Agent and HTTP Request recipes until users choose to open them.
- Complete the HTTP Request recipe with authorization, content type, and a
  copyable sample Responses API JSON payload.

### Fixed

- Copy credential values reliably in Opera GX on Windows by preserving the
  synchronous user gesture for the selection-based clipboard path before
  falling back to the modern Clipboard API.

## [0.2.12] - 2026-08-04

### Fixed

- Install the pinned `openai-oauth@2.0.0` helper with its exact compatible
  `zod@4.1.8` peer even when inherited npm settings omit peer dependencies,
  preventing the Windows sign-in helper from exiting before it prints a URL.
- Accept the same strictly validated authorization line from either helper
  output stream, including Windows terminal framing and final drained output.
- Run npm package builds through the current Node.js runtime on Windows instead
  of executing `npm.cmd` directly with `shell: false`.

## [0.2.11] - 2026-08-04

### Fixed

- Open the private Windows wizard URL through the documented default-browser
  association instead of asking Explorer to treat the URL as a folder, while
  retaining the printed URL and Enter-to-retry fallback.
- Make the Command Prompt installer copy call the system Windows PowerShell
  executable directly, avoiding ambiguous `powershell` command resolution.
- Parse the supported `openai-oauth@2.0.0` login line across Windows terminal
  control sequences and chunk boundaries, and report a sanitized, actionable
  callback-port conflict instead of a generic missing-link error.

### Security

- Pin the hosted web tooling to `brace-expansion` 5.0.9, which includes the
  upstream denial-of-service fix required by the release audit.

## [0.2.10] - 2026-08-03

### Fixed

- Probe installed Windows Node.js runtimes with the literal `node --version`
  output instead of a `node -p` expression, avoiding the PowerShell `[eval]:1`
  quoting failure while still reusing Node.js 22 or newer.
- Let interactive wizard terminals reopen the local browser page when the user
  presses Enter, while retaining the printed private URL as the fallback for
  noninteractive launches.
- Navigate the preopened local OAuth tab before severing its opener access,
  show an immediate preparing state, and close an unnavigated waiting tab if
  sign-in setup fails.

## [0.2.9] - 2026-08-02

### Fixed

- Launch the local ChatGPT OAuth helper through the current Windows Node.js
  runtime and npm's JavaScript CLI instead of executing `npx.cmd` directly,
  preventing `spawn EINVAL` while preserving the native `npx` path on macOS,
  Linux, WSL, and Git Bash.
- Explain how to recover when a refreshed wizard page no longer has its private
  session URL.

## [0.2.8] - 2026-08-02

### Changed

- Replace the local browser wizard's text appearance selector with compact,
  accessible System/Light/Dark icons, while keeping the original horizontal
  Signal Spine flow and touch-friendly behavior.
- Serve the bundled Lucide SVG assets from the wizard and include them in the
  npm package so offline and Node-free browser launches render consistently.

## [0.2.7] - 2026-08-02

### Changed

- Restore the original Relmio hosted layout and local browser wizard flow, with
  the horizontal five-step Signal Spine and GitHub star/version control kept
  visible.
- Add Astryx's built theme and accessible segmented appearance control to the
  hosted app, plus lightweight System/Light/Dark preference support to the
  local wizard.
- Add responsive dark-mode logo treatment, phone-sized controls, and matching
  browser-wizard guidance to the GitHub and npm README variants.

### Fixed

- Keep the checksum-verified temporary Node.js 22 runtime on the child process
  path so Git Bash and other Node-free systems can launch the Relmio package
  shim without falling back to a missing or outdated system `node` command.

## [0.2.6] - 2026-08-02

### Added

- Add a curl-based wizard bootstrap for macOS, Linux, WSL, and Git Bash that
  reuses Node.js 22+ or downloads and checksum-verifies a temporary official
  runtime when Node.js is not installed.
- Add a native Windows PowerShell bootstrap for PowerShell and Command Prompt
  that works without Git Bash or a preinstalled Node.js runtime and verifies
  the temporary official Windows archive before execution.
- Expand the hosted installer into an accessible macOS/Linux, PowerShell,
  Command Prompt, and NPX terminal switcher.

### Changed

- Revamp the hosted Vercel experience and local browser wizard around the
  Signal Spine composition and Patchbay Ledger design language.
- Integrate the Astryx component system, neutral theme, CLI, and AI-readable
  setup guidance in the hosted React application while keeping the published
  wizard dependency-light.
- Add persistent route context, sanitized preview status, responsive layouts,
  reduced-motion behavior, and synchronized GitHub/npm setup documentation.

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
