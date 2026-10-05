# Changelog

This project follows semantic versioning. Each completed release uses one
version across `package.json`, `package-lock.json`, this file, the Git tag,
and npm. Local checks validate the repository metadata; the publishing guide
checks the registry separately after publication.

## Unreleased

### Added

- The ChatGPT plan sidecar's `/v1/chat/completions` route now accepts function
  tools, assistant tool calls and tool results. Function tools go to OpenAI in
  one `additional_tools` item, and n8n still runs the tools. Limits are 32 tool
  calls, 128 KiB of arguments per call and 2 MiB of streamed arguments. A named
  `tool_choice`, tool namespaces and custom tools in streamed requests are
  rejected. Tool roundtrips were tested only against a fake provider.
- An interrupted local or VPS ChatGPT install shows as staged and can be
  resumed after a review that names the selected account, without deleting
  data or starting a second refresh writer. Turning plan use on or off, or a
  token refresh, before resuming does not block it.
- If the destination accepted a session but the acknowledgment was lost, a
  reviewed reconcile finishes the handoff from the destination's receipt.
  Without a receipt the sender stays frozen and needs a fresh sign-in.

### Changed

- The website's Doorway illustration is unframed again, spanning the page
  against its background instead of sitting inside a rounded, layered card.
  The current colors, animation and Pause control are preserved.

- Document the local SIWC account, permission, and model-access flow, including
  protected per-registration credentials, private n8n/VPS transfer boundaries,
  current unsupported capabilities, recovery, and unresolved provider limits.

- A refresh that returns HTTP 503 `temporarily_unavailable` now keeps the
  session from before the refresh instead of freezing it. This assumes OpenAI
  did not rotate the token, which OpenAI does not document.
- If ownership moves but a later finishing step fails, the result still shows
  the one-time key once, with a warning not to use it until the issue is
  resolved.

### Fixed

- Sign-in no longer fails after you allow access. OpenAI sends the ID
  token's audience as a one-element list, which Relmio wrongly rejected. Found
  in a live sign-in test.
- Sign-in no longer fails when OpenAI's callback includes its documented
  optional `scope`. An `iss` value, when present, must match the issuer.
- Declining in ChatGPT now shows a declined message instead of a generic
  verification failure. Declining plan use keeps the existing registration.
- Function tools without `parameters` or `strict` now send both as `null`.
- The chat route skips reasoning output items, so Chat Completions clients
  never receive them.
- A callback with the wrong state no longer cancels the sign-in in progress.
- Session locks now record the holder's process namespace and boot. A lock
  from an earlier boot is reclaimed at once, and one held from another
  container on the same boot after a 10-minute lease. Holders stop after a
  2-minute deadline, and waiters get 503 `siwc_lock_unavailable` after 2.5
  minutes.
- Session lock records are published atomically, so a crash cannot leave a
  half-written lock, and release waits through short contention. A refresh
  that has started is no longer cancelled when the caller disconnects, and the
  rotated token is saved. Keep the SIWC store on a local disk used by one
  kernel, not on a synced folder or network share. Windows cannot flush a
  folder to disk, so on Windows the lock skips that step and relies on NTFS.
- On Windows, owner-only file checks now run in one PowerShell process that
  stays open for the whole Relmio run, so a check no longer starts a new
  PowerShell. Relmio checks its own process identity once per run, skips
  rechecks of files it locked down itself until their change time or contents
  change, and always checks files it did not create.
- On Windows, an existing owner-only SIWC folder is checked but not rewritten,
  so one sign-in no longer disturbs another process's files. Session locks
  retry briefly when antivirus or another process holds a lock file for a
  moment.
- The Codex App Server's live model check now runs inside the running
  container instead of a one-off helper container.
- Status and sign-out for a completed VPS install keep working after n8n is
  recreated or the SSH login method changes. Completed installs bind only the
  SSH host identity and Docker network ID; interrupted installs still bind the
  full reviewed target.
- The ChatGPT plan notice opens only once its view is visible. Escape closes
  it without confirming, and Review plan notice opens it again.
- At a usage limit, Manage usage is a readable primary button in both themes.
  The account card hides Using ChatGPT plan and Pause plan use, and the wizard
  keeps Check the server off.
- ChatGPT account controls stay disabled in preview after a background check
  ends. After Sign out, focus moves to the account status.
- The ChatGPT account card fits one screen at laptop sizes in the wizard and
  on This computer. It no longer repeats the selected account, and the plan
  badge sits beside the status. Recovery lists show "owned here" and
  "transfer pending" instead of internal state names.
- When finalization fails after an install, or the runtime cannot be
  verified, the Ready step says to save the one-time key and not use it yet.
  It no longer shows Using ChatGPT plan or n8n setup wording, and the warning
  sits in a callout. The model select, the server's model picker and its HTTP
  recipe copy stay disabled.
- The Ready step on This computer fits one screen at laptop sizes. Key safety
  notes sit beside the account card, the installed account's session controls
  are in a disclosure, and repeated key and URL guidance is gone. Opening the
  chat tester no longer scrolls the whole page.
- A chat tester error and its Manage usage button scroll into view before
  focus moves to the error, and again once Send returns. Stop response is now
  the same height as Send.
- The VPS review shows the SSH host key once, under Host key and build
  details, so the plan fits one screen. From 1024 to 1279 pixels, step 5 puts
  the base URL and key under their labels at full width.
- Checkbox and radio labels are at least 24 pixels tall.

### Security

- VPS installs bind the reviewed n8n container and network IDs and check them
  again before writing and before the session transfer.
- VPS SIWC files are published atomically under `/docker/n8n-openai-oauth`,
  and unsafe parents or linked targets are rejected. Every SSH command has a
  finite deadline: 45 minutes by default, 30 minutes for a build, 2 minutes for
  handoff acceptance and 5 minutes for file publication. A timeout reports an
  unknown outcome and is not retried.
- Recovery never restarts an old writer automatically. Switching to a fresh
  account after a "not accepted" result is refused if the original receipt
  appears, and on a VPS while a one-off helper container is still present.
- The docs now state plainly that the Codex App Server target is high trust.
  Its relay forwards every client call except a short deny-list to an App
  Server running as the same user as the SIWC store, so connect only trusted
  local clients.

## [0.18.6] - 2026-10-04

Relmio 0.18.6 makes the selected theme and keyboard focus easier to distinguish.

### Fixed

- The selected theme in the local wizard and website has a high-contrast inset
  ring in both themes, so it stays visible after focus moves away. In forced
  colors, selection and keyboard focus have separate indicators. Theme behavior
  and control sizes are unchanged.

## [0.18.5] - 2026-10-03

Relmio 0.18.5 changes the light theme from pastel yellow to pastel green.

### Changed

- The light theme of the local wizard and the website is now pastel green
  instead of pastel yellow. Pages, panels, lines, selected items and the home
  page's day scene use the new greens, and success messages use a cooler green
  so they stay distinct from the page. Text contrast still meets WCAG AA. The
  dark theme is unchanged.

## [0.18.4] - 2026-10-03

Relmio 0.18.4 restores browser format checks on the `/hosting` plan details.

### Fixed

- Hosting plan detail fields on `/hosting` check their format in the browser
  again. Most field patterns used characters that browsers reject, so the
  browser skipped the check and a malformed value only failed later with a
  general error. Accepted values are unchanged.

## [0.18.3] - 2026-10-03

Relmio 0.18.3 names SSH fields by their visible labels in setup errors, and
records that the hosted chat on the website is turned off while Relmio
applies to OpenAI for access.

### Changed

- The hosted chat and its ChatGPT sign-in are turned off while Relmio applies
  to OpenAI for access. The home page's chat section now says so, links to the
  local wizard and offers **Remove saved sign-in from this browser** for people
  who signed in before. The top bar and footer no longer link to the chat, and
  `/chat` still redirects to the notice at `/#chat`. ChatGPT sign-in now works
  only in the local wizard.

### Fixed

- SSH setup errors name the field by its visible label, for example "Server
  address is invalid." instead of "Hostname is invalid.", on the home server
  route, `/assistant`, `/supergrok-vps` and `/local-model-vps`.

### Security

- `/api/chat` no longer reads credentials or forwards anything to OpenAI.
  Every request gets `410 Gone` with `Cache-Control: no-store`. The site no
  longer ships the hosted sign-in packages, and its Content Security Policy no
  longer allows connections to `auth.openai.com` or the Firefox extension
  frame on `localhost:1455`. Removing the saved sign-in clears it from the
  browser only; it does not revoke access at OpenAI.

## [0.18.2] - 2026-10-03

Relmio 0.18.2 fits the remaining wizard steps on one screen at laptop and
desktop sizes, including SSH sign-in, review, install and failure states.

### Fixed

- On `/local` and `/assistant`, a long error or an opened rail disclosure no
  longer makes the whole window scroll. The rail notes scroll on their own
  and the step panel keeps its actions in view. The rejected-port error with
  "This computer only" open and every local install failure now fit at
  1024 x 768, 1280 x 720 and 1366 x 768.
- The `/local` rail shows the ChatGPT credential copy only for ChatGPT for
  n8n, and `/assistant` shows the verified server once on the review step.
- Wizard steps that overflowed at 1024 px now fit on one screen: the home
  Assistant result and install-failure error, `/assistant` while installing,
  the `/local` review, the `/supergrok-vps` server check, the
  `/local-model-vps` removal review and long `/hosting` detail forms. Fit
  panels use slightly tighter padding from 1024 to 1279 px, the home error
  takes a full-width row under the step title there, and the home Assistant
  result says its settings note once.

## [0.18.1] - 2026-10-02

Relmio 0.18.1 returns the hosted site to its scrolling layout with a new
footer, and fixes accessibility, keyboard and security-policy findings from
a Front-End Checklist audit of the wizard and the site.

### Added

- Add a footer to every page of the hosted site with product links, the
  creator's GitHub, X, LinkedIn, YouTube, Facebook and Ko-fi links, and the
  copyright and license line.
- The hosted home page describes Relmio and its creator to search engines
  with structured data.

### Changed

- The hosted site scrolls as a normal page again. The home page returns to
  its hero, How it works, hosted chat and safety sections in the shared theme,
  and `/chat` redirects to the chat section at `/#chat`. The one-screen layout
  stays with the local wizard and dashboard.
- The hosted site now enforces a Content Security Policy with a fresh nonce
  on every page. Only the site's own scripts run. Network connections stay
  on the site or at `auth.openai.com`, with one frame allowed for Firefox's
  extension detection endpoint. HSTS now covers subdomains.
- The local dashboard's Connections view has one primary button, Add
  connection. Setup, resume and sign-in actions in rows and the detail card
  keep the 40 px size in the default style.

### Fixed

- The hosted ChatGPT extension dialog takes focus, keeps keyboard navigation
  inside, closes on Escape and returns focus to sign-in. Its title and focus
  ring remain readable in dark theme, and its links announce a new tab.
- The hosted sign-in flow can check Firefox's extension through its exact
  loopback detection URL without relaxing the script nonce policy.
- The decorative footer wordmark no longer blocks clicks on the license link.
- Local management views keep one primary action and hide the Docker status
  when no Docker check runs.
- SuperGrok and Local model VPS errors sit directly after the footer actions
  on narrow screens and remain in the rail on desktop.
- The wizard's initial SSH status check returns a normal not-connected
  response instead of logging an HTTP error. Connection-required operations
  still reject requests until the VPS is connected.
- New-tab links in the hosted footer, extension installation callout, sign-in
  dialog, sign-in credit and local ngrok checklist show an external-link
  indicator and announce the new tab.
- Docs, install, changelog and guide descriptions are unique, complete
  summaries of 120 to 160 characters that end at a full sentence, and the
  FAQ opens with a short intro.
- The GitHub chip's version follows the newest stable npm release within
  minutes.
- Standalone links on the hosted site, including guide links, reference
  lists in the docs and the sign-in attribution, have at least a 24 px
  target. Quiet links keep their underline inside sentences.
- Primary and removal buttons on the local dashboard use the standard 40 px
  size.
- In Windows high contrast and other forced-color modes, the stepper shows
  the current step as a filled, ringed disc and finished steps as a check.
- Local dashboard rows show each service's full name, state and boundary
  instead of cutting text off. The selected connection card holds the longer
  description.
- A rejected port, or another rejected first-step field, on the local setup
  page is marked invalid and linked to the visible error until you correct
  it.
- On narrow screens, a blocking error on the local setup page sits right
  after the step's footer buttons instead of below the Docker status.
- Standalone wizard links, including Compare hosting routes, the server setup
  links, hosting sources and the local troubleshooting link, have a 24 px
  target.
- Docs code blocks, wide docs tables and the wizard's hosting comparison
  table can be scrolled with the keyboard and show the focus ring.
- The stars on the home page's night band stop twinkling within 5 seconds.
- Browsers that ask for `/favicon.ico` or an Apple touch icon get the Relmio
  logo instead of a missing page.

## [0.18.0] - 2026-10-01

Relmio 0.18.0 brings private local models for n8n, wider VPS support and
hosting plans to the stable channel, with a redesigned wizard and website.
Features that are not fully tested carry an Experimental label.

### Added

- Install one CPU Ollama model from an allowlisted catalog beside an existing
  n8n container, on local Docker or a VPS. Relmio measures memory, CPU and disk,
  reviews the exact download and resources before you confirm, publishes no
  host port, and needs no provider sign-in or API key. Model-only checks ran on
  local Docker and a Hostinger VPS. Linux full-stack acceptance is tracked in
  [issue #86](https://github.com/Demonbane18/relmio/issues/86), and a reported
  120-second local inference timeout on cold model loads remains open.
- Sign in to a VPS with a local SSH agent and the image's real username. A
  verified passwordless `sudo -n` login can manage the model only; the OAuth
  bridge, AI Assistant and SuperGrok still need direct root.
- Compare hosting products and generate manual plans for provider profiles,
  model and search artifacts, Daytona handoffs and restricted relays. Plans do
  not contact providers, provision resources or change n8n.
- Add a maintainer harness for model acceptance on disposable Linux n8n hosts.
  No live Linux result is claimed yet.
- Publish per-page canonical URLs and social previews, plus `robots.txt` and a
  sitemap, for the hosted site, and return a branded page for unknown wizard
  and website addresses.

### Changed

- The stable channel (`relmio@latest` and the hosted installers) now includes
  local models and hosting plans. Relmio is tested on Hostinger KVM VPS and
  local Docker. Other VPS hosts, hosting-plan platforms, the SuperGrok adapter,
  Codex App Server and Codex Chat Adapter are labelled Experimental.
- Set up a VPS in five visible steps: choose a route before ChatGPT sign-in,
  confirm the SSH fingerprint before entering credentials, and keep the
  required plan review in view. The credential-upload destination comes from
  the verified SSH identity; going back or changing the identity clears the
  reviewed plan and approval.
- Share one UI kit and top bar across the local wizard and website, with a
  pastel-yellow light theme and black dark theme. Fit wizard and dashboard
  views to one screen on laptop and desktop displays, use a smaller top-bar
  logo, move hosted chat to `/chat`, and clarify its disclosures.
- Clarify callback recovery, the system-browser Codex login boundary, Windows
  launcher path limits and API-key scope: managed OAuth flows do not configure
  upstream API keys, and API-key connections and hosting artifacts are
  configured separately. Record the 2026-09-27, 2026-09-29 and 2026-10-01
  OpenAI source reviews.

### Fixed

- Wizard: keep focused controls and view headings clear of the top bar and
  footer on phones, show each step's primary action on the first phone screen,
  keep long steps and the local model removal review within one screen, and
  stop progress cards covering warnings and footer actions.
- Hosted chat on narrow phones: starter prompts stay usable, and Jump to latest
  appears only when a conversation exists.
- Read progress and status updates aloud while an operation runs.
- Accessibility: copy buttons keep stable names, announce results politely and
  copy the text shown; rejected fields are linked to their errors; Tab keeps
  working while an operation runs; focus returns to the composer or transcript
  after a chat response or sign-out.
- Hosted chat: name the sign-in flow as the unofficial third-party Codex flow,
  describe who receives the prompt and tokens, label sign-out as local, and
  return every response with `Cache-Control: no-store`.
- Model readiness: accept Docker's canonical Buildx `current` record and enabled
  `no-new-privileges` forms without weakening those checks, keep the owned
  Ollama cache across restarts and retries, and verify the manifest digest and
  quantization before readiness.
- Track the matching Codex login attempt and require confirmed helper shutdown
  before another sign-in. A delayed SSH-status response no longer replaces the
  identity adopted for review. Managed Windows paths decode as strict UTF-8,
  and opening hosting options keeps the private session.
- Ignore forwarded hosts when building crawler and metadata URLs, and send
  `Permissions-Policy` with the other hosted security headers.

### Security

- Keep model-only passwordless sudo separate from OAuth bridge, Assistant and
  SuperGrok VPS access. Temporary Buildx state stays inside reviewed operation
  locks; an unknown SSH or SFTP outcome keeps the lock and state for
  inspection.
- Require the VPS model ownership marker to stay root-owned, mode `0600` and
  single-link. Generated relay runtimes process request bodies and send the
  operator's upstream bearer to the fixed upstream; their logging and retention
  remain unknown.
- Credential contents and recipients, OAuth behavior and provider permissions
  are unchanged. The ChatGPT bridge remains unofficial, private and
  policy-uncertain; provider approval and account entitlement are not
  established.
- Update the hosted web framework to Next.js 16.3.8 and pin patched `undici`,
  `brace-expansion` and `fast-uri` releases to address newly reported
  advisories.

## [0.18.0-experimental.4] - 2026-09-29

### Fixed

- Remove stale pre-publication wording from experimental installation docs.
  Wizard and runtime behavior are unchanged.

## [0.18.0-experimental.3] - 2026-09-29

### Changed

- Put the VPS route chooser before ChatGPT sign-in and present setup in five
  visible steps, with SSH fingerprint confirmation before credentials and
  the required plan review kept in view.
- Identify the credential-upload destination from the currently verified SSH
  identity. Back navigation or an identity change clears the reviewed plan
  and approval; separate human confirmation remains required before remote writes.

### Fixed

- Prevent a delayed startup SSH-status response from replacing the identity
  adopted for review or leaving stale consent text after a newer connection
  decision.

### Security

- Credential contents and recipients, OAuth behavior, provider permissions,
  and bridge capabilities remain unchanged. The bridge remains unofficial,
  private, and policy-uncertain; provider approval and account entitlement
  have not been established.

## [0.18.0-experimental.2] - 2026-09-28

### Fixed

- Accept a bounded canonical Docker Buildx `current` record with an empty
  `Name` without interpreting its `Key`. A named `default` still requires the
  exact reviewed Docker host, and fallback, shadowed-default, and other saved
  selector checks remain fail-closed.

- Accept Docker's bare, `:true`, and `=true` enabled `no-new-privileges`
  forms during local and VPS model readiness checks. Conflicting or malformed
  values still fail closed; this fixes false readiness failures without
  weakening the security requirement.

## [0.18.0-experimental.1] - 2026-09-27

### Added

- Add provider-free local and dedicated VPS Ollama model setup for n8n Chat
  Models, with reviewed network attachment, measured Docker capacity, an
  allowlisted catalog, and bounded inference-readiness checks.
- Add local SSH-agent and editable image-qualified Linux usernames, plus a
  verified noninteractive sudo mode limited to model management.
- Add the authenticated hosting catalog and manual-plan generator for provider
  profiles, model/search artifacts, Daytona handoffs, and restricted relays.
  Plans do not contact providers, provision resources, modify n8n, or prove
  runtime compatibility.
- Add an interactive Linux model-acceptance harness for disposable n8n
  scenarios; live Linux/provider acceptance remains separate and unclaimed.

### Changed

- Keep `0.17.5` as the stable npm `latest` and hosted-installer default. The
  experimental wizard is opt-in through `relmio@experimental` or its exact
  prerelease version.
- Clarify callback recovery, the system-browser Codex login boundary, Windows
  launcher path limits, and the distinction between planner generation and
  operator-deployed runtime behavior.
- Record the 2026-09-27 OpenAI source review. It distinguishes partner identity
  sign-in from the bridge's complete host-side Codex credential copy and records
  unresolved scopes, permissions, model entitlement, runtime data recipients,
  logs, and retention.
- Document SSH host-key, privilege, temporary Buildx state, and recovery
  requirements without enabling root/password SSH or changing n8n.
- Shorten the experimental server wizard to five steps, with optional setup
  guidance in expandable details and the required plan review kept in view.

### Fixed

- Track the matching Codex login attempt and require confirmed helper shutdown
  before another sign-in; inconclusive callback-port probes are not treated as
  proof that the port is free.
- Preserve the owned Ollama cache across restarts and retries, verify catalog
  manifest digest and quantization before readiness, and retain bounded pull
  streaming, parsing, and inference deadlines.
- Decode managed Windows paths as strict UTF-8 before applying existing
  owner-only ACL checks.
- Preserve the private setup session when opening hosting options directly.
- Pin model-specific setup commands to this prerelease so they do not open
  the stable wizard, which does not include the new model setup.

### Security

- Keep model-only passwordless sudo separate from OAuth bridge, Assistant, and
  SuperGrok VPS access. Constrain temporary Buildx state to reviewed operation
  locks and attest the default builder without changing the user's saved config.
- Require the VPS model ownership marker to remain root-owned, mode `0600`, and
  single-link through pre/post-upload checks. Across OAuth/model/Grok VPS
  operations, unknown SSH/SFTP outcomes retain the operation lock and Buildx
  state for inspection; verified failures use normal cleanup.
- Document that generated relay runtimes process request bodies and send the
  separately configured upstream bearer to the fixed upstream. Cloudflare
  observability is enabled in generated artifacts; actual field-level logging
  and retention remain unknown.

New provider deployments, local-model inference, throughput, and provider
entitlements were not live-tested for this prerelease. Offline planner/profile
checks are not runtime certification.

## [0.17.5] - 2026-09-26

### Added

- Add a dated official-source review confirming that the callback-port check
  does not alter Relmio's authentication, permissions, data handling, logging,
  or recipients.

### Fixed

- Probe the default callback port on both IPv4 and IPv6 loopback before local
  and VPS OpenAI OAuth sign-in, and report that an existing listener could
  interfere. The page reported by the original sign-in failure did not establish
  which application displayed it or received a callback.

### Changed

- Explain the **OpenAI OAuth** "Signed in to ChatGPT / This sign-in request
  expired" page, add Windows PowerShell commands that inspect port `1455`
  without stopping anything, and state that an MCP `Transport closed` error
  comes from the AI client's MCP server, not from Relmio.

## [0.17.4] - 2026-09-21

### Added

- Add a dated official-source review confirming that the canonical-domain
  change does not alter Relmio's authentication, permissions, model request,
  data handling, logging, or recipients.

### Changed

- Make [relmio.jpfusin.tech](https://relmio.jpfusin.tech/) the canonical
  website, documentation, package homepage, and hosted-installer origin.
- Permanently redirect requests from `relmio.vercel.app` to the matching path
  on the new canonical domain so existing links keep working.

## [0.17.3] - 2026-09-18

### Changed

- Lead bare `relmio`, NPX, and hosted installer launches with **ChatGPT on my
  server** while keeping `relmio local` as the explicit computer-only route.

## [0.17.2] - 2026-09-18

### Changed

- Open bare `relmio`, NPX, and hosted installer launches as a foreground
  browser wizard without creating persistent Relmio state. A clean first-run
  machine may have no `.relmio` directory and no local n8n stack; prerequisite
  guidance now remains inside the wizard.
- Run the complete release gate plus focused PowerShell, CMD, browser handoff,
  ACL, and Codex login checks on native Windows CI.

### Fixed

- Keep a successfully dispatched Windows browser handoff alive even when
  `explorer.exe` later returns a nonzero status, preventing the temporary page
  from disappearing with `ERR_FILE_NOT_FOUND`.
- Retry native Command Prompt temporary-runtime cleanup when Windows briefly
  holds an executable open, and report an actionable nonzero failure if cleanup
  remains blocked.
- Give the hosted Git Bash launcher a real native child terminal and normalized
  Windows runtime path through its bundled `winpty` and `cygpath` tools, while
  replacing GUI-dependent Windows CI coverage with a headless native-console
  test.
- Use native Windows Node/npm process boundaries, owner-only temporary browser
  handoffs, and isolated official Codex login attempts with validated atomic
  credential promotion and actionable cancellation errors.

## [0.17.1] - 2026-09-14

Relmio 0.17.1 makes streamed replies calmer and clearer in both the hosted
chat and the browser wizard's Test AI Chat console.

### Changed

- Distinguish sending, connecting, waiting for first text, active streaming,
  completion, interruption, and failure without announcing every text chunk to
  assistive technology. Reduced-motion mode keeps equivalent static cues.
- Keep partial text primary and visible when a response is stopped or fails,
  with stable message sizing and explicit retry-ready terminal states.

### Fixed

- Ignore empty stream deltas as non-visible output and keep pre-token progress
  monotonic, preventing blank replies or backward status changes.

The Codex Chat Adapter `POST /chat` protocol and external clients such as n8n
are unchanged. Node.js 24+ and the hosted chat's exact `gpt-5.6-luna` request
remain in place.

## [0.17.0] - 2026-09-14

Relmio 0.17.0 is a pre-1.0 compatibility milestone that moves supported setup
paths to Node.js 24 and updates the hosted web chat to GPT-5.6 Luna.

### Added

- Add a dated official-source review for the Node.js 24 runtime and hosted
  Luna request, including authentication, data-flow, policy, entitlement, and
  native-platform limits.

### Changed

- Require Node.js 24 or newer across the browser wizard, hosted launchers,
  package metadata, CI, release validation, and current setup guidance. Portable
  launchers now select a checksum-verified Node.js 24 runtime; the native CMD
  launcher pins the reviewed official Node.js 24.21.0 archives.
- Use the exact `gpt-5.6-luna` model ID for the hosted web chat request and its
  visible model label. This does not change n8n, image, audio, console,
  provider, or local endpoint defaults.

Hosted Luna access still depends on the signed-in account and compatibility
transport. This release does not establish broader model entitlement or Terms
approval.

## [0.16.0] - 2026-09-12

Relmio 0.16.0 brings GPT Image 2.5 discovery and selection guidance to the
browser installer for new and existing OpenAI OAuth bridges.

### Added

- Discover the exact Flare and Sunburst image model IDs alongside existing
  models, including GPT Image 2. Both 2.5 variants were tested with n8n's native
  image generation and editing nodes on the current account.
- Show discovered image choices and copyable IDs after bridge installation or
  update, with instructions for n8n's image model selector.

### Fixed

- Recognize the unchanged runtime from Relmio 0.15.0 during a local bridge
  update instead of rejecting it as file drift. Modified or unowned files
  still fail closed; updates retain the saved sign-in and leave n8n untouched.

### Changed

- Simplify local and VPS setup with clearer visual choices and plain-language
  labels. Keep specialist local tools and technical explanations behind
  expandable details while retaining every setup option and approval step.
- Keep GPT-Live and Realtime models out of this bridge's discovery response
  and return explicit unsupported-operation guidance for their session routes.
  Audio remains a separate unsupported capability through this OAuth bridge.

### Security

- Update the hosted web framework, image-processing dependency, and YAML parser
  to versions that address the newly reported Next.js, sharp, and js-yaml advisories.

Existing bridges need a reviewed runtime update to receive the new catalog.
Exact output dimensions, all image options, and universal account access remain
unverified. The bridge remains unofficial and policy-uncertain; this release
adds no Platform API-key fallback or new credential permissions.

## [0.15.0] - 2026-09-08

Relmio 0.15.0 adds browser-driven updates for existing OpenAI OAuth bridges
and repairs n8n OpenAI node compatibility on local Docker and VPS deployments.

### Added

- Update an existing local or VPS OpenAI OAuth bridge from the browser wizard.
  Local updates preserve the saved sign-in; VPS updates upload the current
  local sign-in. Both rebuild only the owned sidecar, retain its selected
  network, leave n8n running, and keep port `10531` private.

### Changed

- Document all 16 n8n OpenAI actions and their current bridge limits. Audio,
  file management, stored conversations, moderation, video, background jobs,
  and stored responses return specific unsupported-operation guidance.
- Make the completion-page Responses API notice dismissible while preserving
  the required setting in the permanent instructions.

### Fixed

- Allow n8n Message a Model requests with Background Mode off by removing the
  disabled `background` parameter before forwarding to the OAuth transport.
  Both sidecar installers bundle the same compatibility adapter.
- Explain failed VPS model checks and route rejected ChatGPT credentials back
  to fresh sign-in. Clear the previous plan and approval before another update.
- Separate the completion notice from the credential heading and report Docker
  network refresh failures without claiming the install or SSH session stopped.

Existing bridges need a runtime update from the wizard to receive these fixes.
Relmio's ChatGPT connection remains unofficial and does not provide every
OpenAI Platform API action.

## [0.14.0] - 2026-09-06

Relmio 0.14.0 adds experimental SuperGrok OAuth for local apps and existing
local or VPS n8n deployments without requiring a ChatGPT sign-in.

### Added

- Add SuperGrok Chat Completions for local apps and private n8n clients using a
  fresh official Grok device sign-in, isolated provider session, and separate
  local Relmio bearer. n8n executes its own tool calls.
- Keep the simple `/chat` interface through the same direct HTTP transport.
- Add a dedicated SuperGrok VPS wizard for verified SSH identity, read-only n8n
  discovery, reviewed installation, device sign-in, model checks, status,
  sign-out, cancellation, and owned-only removal. The companion joins one
  selected Docker network and publishes no host port.

### Changed

- Use one guided browser flow for provider, local or VPS destination, discovery,
  review, sign-in, and completion. Provider changes invalidate stale plans and
  keep the OpenAI OAuth and SuperGrok instructions distinct.
- Redesign the public homepage with the original Relmio mascot, a full-width
  day/night landscape, timed destination labels, and accessible motion controls.
  Keep the install wizard focused on large controls and plain instructions.
- Limit provider setup to OAuth. Remove upstream API-key gateways, profiles,
  registration and selection routes, and the API-key n8n xAI sidecar.
- Show seven dashboard services and four provider-owned OAuth entries. Keep
  runtime health, provider readiness, and inventory freshness independent.
- Preserve the last observed state while inventory is stale and disable
  maintenance actions until a successful refresh.
- Document the provider-specific n8n setting prominently: the Relmio OpenAI
  OAuth recipe uses Responses API on, while SuperGrok requires it off for
  workflow model nodes and Chat Hub.
- Keep existing API-key gateways and credential data running but outside the
  0.14.0 dashboard. Refuse to adopt an earlier SuperGrok development install
  that lacks the fresh-session marker.

### Fixed

- Keep endpoint URLs readable on narrow dashboard layouts.
- Use supported Docker Compose run options for Grok login and version probes.
- Keep Windows identity and unsafe-path tests portable by forwarding filesystem
  metadata options and using a directory junction that does not require
  Developer Mode or administrator-created symbolic links.
- Document that Git Bash 2.38.1 needs per-process `MSYS=enable_pcon` for the
  portable launcher TTY check, with native PowerShell and Command Prompt as the
  supported alternatives. No global Git setting is required.

### Security

- Pin Grok's executable inside the image and disable automatic update checks.
- Read only the current runtime's marked private OAuth session. The official
  CLI remains the credential writer; the HTTP handler does not execute CLI
  tools, import other applications' credentials, or consume refresh tokens.
- Preserve existing API installations and credential data without adopting,
  migrating, or deleting them through the OAuth-only runtime.
- Require SSH host-key confirmation, an exact reviewed plan, and final human
  confirmation before every VPS write. Keep the companion under
  `/docker/n8n-openai-oauth`, leave n8n unchanged, and remove only resources
  that pass exact ownership checks.

## [0.13.0] - 2026-09-04

### Added

- Add owner-scoped local dashboard lifecycle commands: `relmio start`,
  `relmio status`, `relmio open`, and `relmio stop`.
- Reopen Relmio's local launcher to rediscover a fixed inventory of six local
  services: the OpenAI API endpoint, both Codex endpoints, the owned n8n stack,
  the OAuth bridge, and the AI Assistant tools.
- Copy verified service URLs and use only actions supported by the latest
  inventory state, including Codex sign-in, client-credential rotation, OAuth
  bridge refresh, owned-stack resume, removal, and a return to setup.

### Changed

- Keep hosted curl, PowerShell, and Command Prompt launches foreground-only
  when they use a verified temporary runtime, while persistent package installs
  can manage the dashboard between terminal sessions.
- Make the persistent dashboard the default local launcher's home while
  keeping the existing four-step **Add connection** setup flow intact and the
  separate VPS flow available through `relmio vps`.
- Present Docker availability, service boundaries, component state, and
  recovery choices in a responsive dashboard that marks stale inventory and
  refreshes it read-only.
- Pair every dashboard rail label with an accessible inline SVG icon, using a
  neutral workflow mark for n8n at the compact navigation size.

### Fixed

- Re-attest exact generated Docker ownership and health before reporting a
  service as healthy, including each companion's selected external n8n
  container and Docker network on Windows.
- Keep owned n8n-stack recovery guidance accurate across Compose validation,
  image pulls, and startup waits. Safe single-line validation details can now
  explain the problem without exposing paths, credentials, or raw Docker
  output, extending the Compose diagnostics introduced in v0.12.2.

### Security

- Open the local dashboard through an owner-only, single-use browser handoff
  whose route-bound capability expires after 30 seconds and never appears in
  process arguments, the visible URL, redirects, or cookies.
- Leave ChatGPT OAuth ownership with the official Codex App Server, keep one
  active account per Codex target, reject automatic account or key changes
  after authentication, rate-limit, or quota failures, and deny undocumented
  provider authentication methods by default.
- Return only sanitized states, components, and allowlisted endpoints from
  persistent inventory. Relmio never reveals stored secrets, and one-time
  values are consumed before returning to the dashboard.
- Recheck owner-only Windows ACLs at mutation time and fail closed before any
  Docker or Compose change when a managed path or file no longer has its
  attested permissions.
- Let operators disconnect the VPS explicitly and close idle authenticated SSH
  sessions after 15 minutes without interrupting an active remote operation.

## [0.12.2] - 2026-09-03

### Fixed

- Let Code Sandbox + SearXNG local n8n setup work on current Docker Desktop
  (Compose v5) instead of failing before images are pulled, and show the
  actual Compose validation error when that step still fails.

## [0.12.1] - 2026-09-02

### Fixed

- Give the first local n8n + ngrok start enough time to pull images and pass
  health checks, and explain image-download versus startup-wait failures
  without exposing Docker output or credentials.
- Explain Windows Docker Desktop WSL `0x800705aa` engine-start failures in the
  local n8n wizard instead of a generic Compose error.

## [0.12.0] - 2026-09-02

### Added

- Support local Docker endpoint, n8n bridge, Assistant companion, and owned
  n8n stack workflows on native Windows with Docker Desktop's attested
  `desktop-linux` engine.
- Add manage/edit actions for detected local and VPS n8n integrations,
  including a fresh ChatGPT sign-in path and Assistant/SearXNG configuration.
- Add a Ko-fi support link to the GitHub and npm README guides.

### Changed

- Guide beginners through ngrok agent-token and user-created Basic Auth fields
  with inline validation, missing-field warnings, locked install controls, and
  visible progress while setup is running.
- Keep the same reviewed browser wizard behavior across PowerShell, Command
  Prompt, npm/npx, curl, and Homebrew launch paths instead of relying on
  shell-specific setup logic.

### Fixed

- Recover interrupted owned n8n-stack operations without moving a newer live
  lock, including crashed processes, PID reuse, incomplete lock publication,
  and a preserved partial-stack recovery result when lock cleanup also fails.
- Wait for generated n8n, ngrok, and sandbox health checks consistently, accept
  the sandbox API's private 8080/9090 metadata, and continue rejecting UDP or
  host-published Assistant ports.
- Preserve existing n8n enabled modules when adding AI Assistant settings and
  leave existing n8n containers, Compose files, images, and restarts untouched.

### Security

- Protect every Windows managed credential directory and file with a
  read-back-verified NTFS DACL limited to the current account before writing
  secrets or invoking a Docker mutation. Remote Docker selectors, Unix sockets,
  and unrecognized named pipes remain rejected on Windows.
- Bind lifecycle ownership to the process creation identity, fail closed when
  liveness is ambiguous, and arbitrate stale recovery before changing the
  canonical local n8n operation lock.

## [0.11.0] - 2026-09-01

### Added

- Add a hosted changelog generated from the repository release history.
- Add a wordless animated sketch banner that keeps Relmio's original
  two-eyed green mascot and cream doorway.

### Changed

- Rewrite the GitHub and npm guides, hosted site, and browser wizard in
  shorter, plainer language while keeping credential and safety boundaries
  explicit.
- Add clearer step-by-step guidance for local ngrok and n8n companion setup.
- Use icon-only copy controls with accessible labels, larger touch targets,
  and responsive layouts across the hosted site and browser wizard.

### Fixed

- Keep a completed local wizard from reopening a consumed setup plan; starting
  another option now prepares a fresh plan.

## [0.10.0] - 2026-08-31

### Added

- Add local n8n companion choices to the browser wizard: an unofficial private
  `openai-oauth` sidecar for an existing n8n container and n8n AI Assistant
  Code Sandbox support with optional SearXNG JSON web search.
- Add a one-click, separately owned disposable n8n + ngrok stack with mandatory
  Traffic Policy Basic Auth, loopback-only local ports, and optional Code
  Sandbox plus SearXNG.
- Add an animated Gateway Android README banner, a two-lane credential-boundary
  diagram, package and project badges, and a concise product introduction.

### Changed

- Bind each companion plan to the exact running n8n container and selected
  existing Docker network; neither path publishes a host port or edits,
  restarts, stops, recreates, rebuilds, or executes inside n8n. Assistant
  settings remain operator-applied.
- Let every completed local setup return to the token-preserving start screen
  so another endpoint can be configured without restarting the wizard.
- Use Homebrew's formula-scoped trust command for the public Relmio tap instead
  of asking users to trust an entire third-party tap.

### Fixed

- Accept only Docker Compose's strict unpublished publisher placeholder while
  retaining fail-closed rejection for real or malformed host publication.
- Give disposable n8n's cache an owner-writable temporary filesystem so n8n AI
  Assistant workspace initialization can complete.
- Keep bind-mounted ngrok and SearXNG configuration readable by their non-root
  containers while parent managed directories remain owner-only.

### Security

- Keep credentials separate: the sidecar uses a private local ChatGPT OAuth
  volume, while the Assistant model-provider credential is configured directly
  in n8n and is not handled by Relmio. SearXNG remains optional and off by
  default.
- Scope the new public exception to the owned n8n route behind mandatory Basic
  Auth; port `10531`, Code Sandbox, and SearXNG remain unpublished, and removal
  requires exact project-wide ownership attestation.

## [0.9.1] - 2026-08-31

### Added

- Add a prominent hosted installer launch option for the separate n8n AI
  Assistant wizard, while retaining every existing general installer method.

### Changed

- Redesign the hosted app as an Editorial Console with an interactive
  four-route Signal Plotter and an improved multi-turn chat console that can
  stop in-flight responses.
- Describe the AI Assistant's SSH-connected self-hosted target without
  provider-specific Hostinger or VPS labels, and document that direct local
  Docker-socket discovery is not supported.

### Fixed

- Stabilize reduced-motion hydration by giving the Signal Plotter a
  deterministic initial signal state before animation begins.
- Keep the hosted repository control's offline metadata fallback synchronized
  with the prepared release version.

## [0.9.0] - 2026-08-28

### Added

- Add `relmio assistant`, a dedicated local wizard and isolated companion
  Compose plan for n8n AI Assistant's self-hosted sandbox and optional SearXNG
  web search.

### Changed

- Add sourced OpenAI policy context to the GitHub README, npm README, and
  canonical security guide, including the maintainer's Codex for Open Source
  acceptance, while preserving the distinction between supported Codex/ChatGPT
  sign-in patterns and unsupported subscription-to-API conversion, resale,
  account sharing, or safeguard bypass.

### Security

- Keep the privileged Docker-in-Docker runner separate from the selected n8n
  network, publish no companion host ports, generate and redact independent
  sandbox secrets, attest ownership-bound random Compose identities and network
  aliases, serialize VPS-sidecar and assistant mutations under one single-use
  plan lock, and retain the strict no-n8n-mutation boundary.
- Pin every generated AI Assistant companion production image to its reviewed
  immutable tag and OCI index digest, with regression coverage that rejects
  floating or digestless references, including the nested sandbox image.

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

[0.14.0]: https://github.com/Demonbane18/relmio/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Demonbane18/relmio/compare/v0.12.2...v0.13.0
[0.12.2]: https://github.com/Demonbane18/relmio/compare/v0.12.1...v0.12.2
[0.12.1]: https://github.com/Demonbane18/relmio/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/Demonbane18/relmio/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Demonbane18/relmio/compare/v0.10.0...v0.11.0
[0.9.0]: https://github.com/Demonbane18/relmio/compare/v0.8.1...v0.9.0

[0.18.6]: https://github.com/Demonbane18/relmio/compare/v0.18.5...v0.18.6
[0.18.5]: https://github.com/Demonbane18/relmio/compare/v0.18.4...v0.18.5
[0.18.4]: https://github.com/Demonbane18/relmio/compare/v0.18.3...v0.18.4
[0.18.3]: https://github.com/Demonbane18/relmio/compare/v0.18.2...v0.18.3
[0.18.2]: https://github.com/Demonbane18/relmio/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/Demonbane18/relmio/compare/v0.18.0...v0.18.1
[0.18.0]: https://github.com/Demonbane18/relmio/compare/v0.17.5...v0.18.0
[0.18.0-experimental.1]: https://github.com/Demonbane18/relmio/compare/v0.17.5...v0.18.0-experimental.1
[0.18.0-experimental.2]: https://github.com/Demonbane18/relmio/compare/v0.18.0-experimental.1...v0.18.0-experimental.2
[0.18.0-experimental.3]: https://github.com/Demonbane18/relmio/compare/v0.18.0-experimental.2...v0.18.0-experimental.3
[0.18.0-experimental.4]: https://github.com/Demonbane18/relmio/compare/v0.18.0-experimental.3...v0.18.0-experimental.4

[0.17.5]: https://github.com/Demonbane18/relmio/compare/v0.17.4...v0.17.5
[0.17.4]: https://github.com/Demonbane18/relmio/compare/v0.17.3...v0.17.4
[0.17.3]: https://github.com/Demonbane18/relmio/compare/v0.17.2...v0.17.3
[0.17.2]: https://github.com/Demonbane18/relmio/compare/v0.17.1...v0.17.2
[0.17.1]: https://github.com/Demonbane18/relmio/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/Demonbane18/relmio/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/Demonbane18/relmio/compare/v0.15.0...v0.16.0
