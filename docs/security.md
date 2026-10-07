# Security and limits

The local ChatGPT plan flow stores a separately authorized SIWC registration.
The selected n8n runtime can receive one registration after reviewed
installation. Direct Codex clients and the read-only Chat Adapter use that
registration through separate local interfaces. SuperGrok keeps its own
session and does not require or read ChatGPT credentials. On a VPS or with the
local sidecar, the opt-in [image add-on](#codex-image-add-on) keeps a second,
separate Codex sign-in. Treat every local bearer and stored provider token as a
secret.

## ChatGPT plan token lifecycle

Relmio stores the granted SIWC scope set and expiry from each token response.
The gateway serializes refreshes for a registration and atomically replaces
rotating token data. It keeps credentials on their owning local or installed
runtime and disables plan use after terminal refresh failure or lost permission.
The one-hour access-token and rotating 30-day refresh-token values in OpenAI's
documentation describe SIWC; they are not lifetimes for a personal Codex
credential. See the [current source check](openai-source-check-2026-10-05.md).

## Hosted chat demo

The website's `/api/chat` is disabled. The route returns `410 Gone` with
`Cache-Control: no-store` without reading its request or contacting a provider.
Local SIWC setup does not enable hosted chat or establish a hosted plan-use
contract.

The former hosted demo used a third-party Codex sign-in and kept encrypted
session data in browser IndexedDB. That is historical behavior, not the current
local registration flow. If a browser still contains the old saved sign-in,
the website's cleanup control or clearing site data removes local browser
state; neither operation revokes the old provider session. Hosting/provider
logs and retention from that period remain unknown.

## Provider authentication boundaries

The local SIWC account is tied to the verified OpenAI issuer, issued client ID,
and subject. Relmio keeps accounts separate even if email labels match. A raw
Codex App Server target uses the selected account's short-lived Responses
access token through an official App Server child over stdio. Its local
WebSocket capability is high trust and intended for a native same-owner
client. The Codex Chat Adapter uses a different local bearer and a narrower
read-only conversational contract for trusted local backends. Neither is a
browser endpoint, hosted service, or general OpenAI `/v1` gateway.

The n8n OpenAI-compatible sidecar uses the selected registration's plan grant
and a separate one-time Relmio bearer. The bearer authorizes the sidecar only;
n8n does not receive provider tokens. The sidecar binds to one selected Docker
network, publishes no host port, and rejects routes or request features it
cannot preserve. Model discovery, sign-in, or container health does not prove
entitlement, host admission, or completed inference.

The experimental SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Relmio never changes accounts automatically or falls back to separately billed
API access after authentication, permission, usage, or provider errors. It
reports a recovery action for the selected account. The dashboard returns
sanitized state, not stored credentials.


## Local dashboard lifecycle boundary

The installed dashboard lifecycle has four commands:

`relmio start`, `relmio status`, `relmio open`, and `relmio stop`.

They manage only the current operating-system account's Relmio dashboard on
`127.0.0.1`. The control credential is separate from the browser session
credential. `relmio stop` stops only the Relmio dashboard process. It does not
call Docker or stop, restart, rebuild, recreate, or edit n8n, ngrok, Relmio
companions, or installed endpoints.

The protected on-disk publication and authenticated health response must agree
on the exact Relmio package version. A version mismatch is never reused or
opened as current. A compatible prior daemon may be stopped only through its
authenticated control endpoint and exact recorded process identity; malformed,
unresponsive, or incompatible control state remains fail-closed.

## Trust model

The design assumes:

- the local computer is trusted;
- the VPS and its root account are trusted;
- other containers on the selected Docker network are trusted;
- The pinned `jose`, `ws`, and `ssh2` dependencies are part of the local
  authentication, relay, and SSH supply chain.

If any of those assumptions is false, do not use this design.

For local Docker endpoints, the design assumes:

- the local computer, operating-system account, and Docker Engine are trusted;
- an app receiving a one-time Relmio bearer is controlled by the same person;
- the bearer is stored by that trusted client, not browser code; and
- the raw Codex App Server client is trusted with its high-trust JSON-RPC and
  local-tool surface. It is not a multi-user, browser, shared-service, or
  untrusted-plugin boundary.

The App Server child receives its short-lived SIWC access token in
`ACCESS_TOKEN`. A trusted tool executing as the same OS user may inspect the
child's own process environment or files. Relmio does not claim an OS boundary
that prevents an authorized native client or its tools from exposing their own
process data. The Codex Chat Adapter remains a separate, read-only
conversational contract for a trusted local backend.

## What the wizard does

- The web server binds only to `127.0.0.1`.
- Every API request needs a random 256-bit session token.
- Automatic browser opening passes only an owner-only handoff-file path to the
  operating system. A route-bound one-time capability expires after 30 seconds
  and is consumed exactly once by a form POST. The response immediately replaces
  that POST with a clean GET using an independent 10-second per-tab transfer,
  which is cleared before application startup. Neither value appears in process
  arguments, a URL, a redirect, a cookie, or browser Web Storage.
- POST requests must have the exact localhost origin.
- Browser responses disable caching, framing, cross-origin access, and
  unnecessary permissions.
- Request bodies and remote command output have size limits.
- Login, fingerprint, and connection attempts are rate-limited.
- Both password and local-agent authentication require confirmed SSH host-key
  trust before authentication; the server binds trust to the normalized host
  and port.
- SSH authentication is an explicit choice, not an agent-to-password fallback.
  Private keys and passphrases stay with the local agent/key store. The SSH
  library uses public identities and authentication signatures; it does not
  export the private key or forward the agent to the VPS. Agent access itself
  remains security-sensitive.
- Safe connection identity includes the account, authentication method and
  verified administrative context. A changed connection invalidates prior plans.
  Capability status does not disclose agent paths or enumerate keys in the browser;
  configured/untested status is not proof of successful authentication.
- Passwords are request-scoped, never saved, never logged, and cleared from
  the page immediately after the connection attempt.
- The VPS flow exposes **Disconnect from VPS** and also closes an authenticated
  SSH session after 15 minutes of inactivity. An active remote operation holds
  a bounded lease; the idle timer resumes as soon as that operation releases
  the connection.
- SIWC registrations use protected per-registration records under
  `N8N_OPENAI_OAUTH_HOME` or `~/.n8n-openai-oauth`. Verified identity, issued
  client, granted scopes, token state, and owner are stored separately from
  browser views. Relmio does not import a personal `~/.codex` credential.
- The setup guide saves one thing: whether it is on or off, as
  `ui-preferences.json` in the same SIWC storage root. The wizard reads it
  with `GET /api/ui/preferences` and saves it with `POST /api/ui/preferences`,
  which accepts exactly `{"guide":"on"}` or `{"guide":"off"}`. Relmio does not
  follow a symbolic link to the file and reads it only when it is a regular
  file of at most 1 KB. Saving creates a missing root (never its parents)
  with mode `0700`. On macOS, Linux and WSL it then writes the file with mode
  `0600` only when the root is a directory this user owns with no group or
  other access, and otherwise skips the write; Windows skips that check. The
  tab keeps the same choice in session storage for reloads. The guide's tips,
  examples and error help are static files shipped with Relmio and shown as
  text. The guide never fills in a field and sends nothing else.
- The top bar's GitHub chip shows the running Relmio version and the
  repository's star count. For the count, the wizard server sends one `GET`
  to `https://api.github.com/repos/Demonbane18/relmio` and keeps the answer for
  15 minutes. If GitHub refuses (it allows 60 unsigned requests an hour per
  address) or cannot be reached, it asks Relmio's website,
  `https://relmio.jpfusin.tech/api/project-meta`, which caches the same count.
  Both requests carry only a `relmio/<version>` User-Agent; GitHub and the
  website's host see your IP address and the request time. When both fail,
  the chip keeps the last count from this run or shows `?`.
- Each registration has a session lock. Its owner record binds the holder
  process, its PID namespace, and on Linux the boot ID. A lock from an earlier
  boot is reclaimed at once. A lock held from another container or PID
  namespace on the same boot is reclaimed only after a 10-minute lease. A
  holder stops without further writes once its 2-minute operation deadline
  passes. A waiting caller retries for up to 2.5 minutes, then gets HTTP `503`
  `siwc_lock_unavailable` with recovery `retry-later`. Lock records are
  published complete and fsynced through an exclusive hard link, so a crash
  cannot leave a half-written lock. Release waits up to 2.5 minutes through
  short contention. A refresh that has started is not cancelled by a caller
  disconnect, and the rotated token is still saved.
- Keep the SIWC store (`N8N_OPENAI_OAUTH_HOME` or the sidecar volume) on a
  local disk used by one kernel. Do not sync it or put it on a network share;
  the lock and atomic-write guarantees depend on that.
- An OAuth callback with the wrong state is rejected without cancelling the
  sign-in in progress.
- Local n8n and VPS installs transfer a selected registration only after
  review, background-use consent, and final install confirmation. A distinct
  destination host ID is created before transfer. The source is frozen before
  handoff and cleared only after an attested destination receipt; uncertain
  outcomes remain frozen. The destination accepts a handoff only for the
  expected registration and records an identity-bound receipt in the same
  write. A lost acknowledgment is reconciled from that receipt after review;
  without a receipt the sender stays frozen and old tokens are never restored.
  An interrupted install resumes only after a review that names the selected
  account, without deleting data or creating a second refresh writer. A fresh
  account can resume only after a confirmed not-accepted result; Relmio
  refuses if the original receipt appears or, on a VPS, while a one-off helper
  container is still present. Relmio never restarts an old writer
  automatically.
- The review binds the immutable n8n container and network IDs. The VPS
  installer re-attests them before its first write and before credential
  transfer, and an interrupted install stays bound to the full reviewed
  target. A completed VPS install binds only the SSH host identity and Docker
  network ID, so status and sign-out survive n8n recreation or an SSH login
  method change; a changed network is still refused.
- **Passwordless sudo -n (model only)** is restricted to local-model operations
  and shared read-only discovery. OAuth bridge, Assistant and SuperGrok VPS
  operations are denied in that context; selecting effective UID 0 via sudo does
  not grant the direct-root route scope.
- Sudo model uploads stream bounded runtime assets and non-secret deployment
  metadata, not provider credentials. Metadata still identifies resources and
  should not be published casually. Remote sudo/sshd auditing can record I/O;
  Relmio does not control administrator logging. This restriction is not a
  blanket “nothing is logged” guarantee.
- Sudo and rootful Docker access are root-equivalent authority, not a general
  OS sandbox. Relmio does not request a sudo password, change sudoers or group
  membership, enable root/password SSH, or silently switch to another daemon.
- Builds must stay on the validated local Docker daemon. The existing context
  must be `default` at `unix:///var/run/docker.sock`. Model preparation reads
  only bounded `$HOME/.docker/buildx/current` and `defaults` selectors and
  checks that `instances/default` does not shadow the built-in builder. A
  changed/mismatched HOME/config location or saved custom/ambiguous builder
  fails closed. On Windows, read-only ACL checks allow inherited access for the
  current user, SYSTEM, and Administrators, reject untrusted owners or
  write-capable untrusted ACEs, and never change ACLs. The workflow rejects
  inherited `BUILDX_BUILDER`, `BUILDX_CONFIG`, and conflicting Docker/Compose
  selectors; it does not alter saved config. It does not print selectors, read
  `config.json`/nodegroup TLS secrets, or invoke Buildx CLI. `docker buildx
  inspect` is not used as a probe: it can write state or expose secrets. Review
  and build/retry re-attest the selection. Explicit helper-image build calls
  pass `--builder default`; Compose `run` calls that can trigger an implicit
  build use the same attested command-scoped config and `BUILDX_BUILDER=default`
  environment, without unsupported Compose flags. No running-builder
  prerequisite or automatic context change is implied.
- `DOCKER_BUILDKIT=0` or another nonempty value other than `1` is rejected;
  classic-builder fallback is not used. Confirmed build-capable actions use
  temporary mode-`0700` Buildx client state inside the owned operation lock,
  with command-local configuration and the built-in default builder. Model
  install/retry, SuperGrok install/sign-in/sign-out and OAuth bridge builds
  disclose their exact [state paths](reference.md#vps-authentication-and-privilege).
  Nonbuilding actions do not create that state.
- Build-state cleanup verifies ownership and inode identity and rejects link,
  mount or ownership ambiguity. An interrupted build or unknown SSH exit
  status retains all state and its lock without cleanup because the writer
  may still be active. Interrupted or uncertain cleanup can leave partial
  state and the lock for administrator inspection. Neither case authorizes
  deletion of n8n or model caches. Registry credentials are not copied, moved
  or printed by this state-management path.
- The root OAuth bridge build context uses a guarded `Dockerfile.dockerignore`
  allowlist for `Dockerfile` and `openai-oauth-sidecar.mjs`. Credentials,
  sibling companions and temporary state are excluded. An existing unknown
  ignore file is not overwritten. Confirmed build confinement is distinct
  from pre-confirmation selection attestation; neither is a host-root sandbox.
- Managed remote file writes are restricted to `/docker/n8n-openai-oauth`.
  `/docker` must already be root-owned, non-symlink and not group/other writable.
  Docker also writes its own approved resource state under its data root.
  SIWC files are published through an exclusive temporary file and an atomic
  rename. Publication rejects symlinked, non-root-owned, or group/other-writable
  ancestors and symlinked, non-regular, or hard-linked targets, and never
  truncates an existing file. Link counts come from a bounded read-only remote
  `stat`.
- VPS local-model assets are reviewed under the selected model lock. The
  `.managed-by-relmio.json` marker and its staged `.next` entry are checked as
  root-owned mode-`0600` regular files with a single hard link; the marker is
  re-attested before and after transfer and promoted only after its content and
  parent identity match. Runtime files are checked against recorded hashes.
- Across VPS OAuth bridge, local-model and SuperGrok operations, a classified
  unknown SSH command result or interrupted SFTP write prevents automatic
  cleanup/release of the operation lock and any Buildx state. This includes an
  unconfirmed OAuth post-install publication/model check; a later responsive
  SSH session does not prove the earlier call's outcome. A partial uploaded
  file may remain. Verified nonzero exits and SFTP setup failures before writing
  starts remain known outcomes and follow normal cleanup. Errors are sanitized;
  raw remote command output is not included. Every SSH command has a finite
  deadline (45 minutes by default, 30 minutes for an image build, 2 minutes
  for handoff acceptance, 5 minutes for managed-file publication). A deadline
  closes that command's channel, reports an unknown outcome, and is not
  retried automatically.
- Docker names are allowlisted before they can enter a command.
- Generated mutation commands come from a closed static allowlist.
- The sidecar runs as user `node`, drops all Linux capabilities, uses
  `no-new-privileges`, and has a read-only root filesystem.
- There is no host `ports` mapping and no reverse-proxy route.
- The installer verifies the absence of a published port after startup.

### Local endpoint controls

- The local OpenAI-compatible n8n sidecar requires the selected registration's
  plan grant and a generated installation bearer. Compose stores only the
  bearer hash. The one-time bearer is entered manually in n8n; provider tokens
  remain in the protected sidecar registration.
- The local n8n sidecar joins only the reviewed network and publishes no host
  port or reverse-proxy route. Relmio re-attests the selected n8n container,
  network, and Docker host before installation. It does not edit n8n
  configuration, credentials, Compose files, image, or lifecycle.
- Existing legacy bridge installations are not silently adopted or replaced.
  They require a fresh SIWC sign-in and separately reviewed migration.
- The separate `n8n-ai-assistant` option always installs Code Sandbox and adds
  SearXNG only after an explicit boolean opt-in. Its privileged
  Docker-in-Docker runner is for local development and testing, not production;
  use Daytona for the production sandbox boundary.
- Assistant services use exact ownership labels and generated identities,
  attach only to the reviewed existing Docker network, and publish no host port
  or reverse-proxy route. Relmio returns the sandbox key and n8n settings once,
  but never changes or restarts n8n and never handles its model-provider key.
- Existing-n8n sidecar and Assistant plans require Docker's exact
  `Internal: false` network state before writing. This proves the selected
  network is not Docker-internal while retaining the independent no-host-port
  verification.
- The separate **Set up new n8n** option creates only a new randomly
  identified Relmio-owned Compose project. It never adopts or changes an
  existing n8n. Its explicit public exception is limited to the new n8n route,
  protected by an ngrok Traffic Policy Basic Auth challenge; local n8n and the
  inspector bind to `127.0.0.1`, and optional Assistant services publish no
  host port or ngrok route. Removal requires exact marker and project-wide
  resource-label attestation before deleting the owned disposable data volume.
- SIWC registration records stay in protected runtime storage. Compose includes
  registration/runtime IDs, storage location, and a local bearer verifier, not
  provider tokens. The n8n bearer is entered manually and shown once.
- The sidecar publishes no host port and joins only the reviewed n8n network.
  Relmio does not edit n8n credentials or Compose settings.
- Tool definitions, arguments, and results from n8n pass through the sidecar
  to OpenAI; the sidecar never executes a tool. A request can list up to 128
  tools. The Chat Completions route limits a request to 32 tool calls,
  128 KiB of arguments per call, and 2 MiB of streamed arguments in total.
  Reasoning output items are never returned to Chat Completions clients.
- The raw Codex App Server target uses a trusted local bearer and has a
  high-trust native-client boundary. The relay forwards every client JSON-RPC
  call except a short deny-list to the official App Server, which runs as the
  same user that owns the SIWC store. Connect only trusted local clients. The
  separate Chat Adapter uses its own bearer and a narrower read-only
  conversational HTTP contract.
- The App Server child receives the short-lived SIWC access token as
  `ACCESS_TOKEN`. A same-UID trusted tool can inspect its own process
  environment or files; no OS isolation from that authorized client is
  claimed.
- The generated Codex App Server configuration disables agent spawning and
  request/stream retries. The relay rejects deferred tool search, hosted
  connector/MCP OAuth, account/auth RPCs, marketplace/plugin/configuration
  mutations, per-thread provider/model/fallback overrides, and path/history/
  rollout selectors on resume/fork. Supported inline function/custom and local
  direct tools remain inside the high-trust boundary; this is not full App
  Server/MCP/agent parity.
- Successful threads are stored in a protected per-registration/runtime
  binding. A resume after restart must match that identity and model; unknown
  or foreign thread IDs fail closed.

- Local API callers do not receive provider tokens through the gateway
  protocol, responses, errors, or deliberate logs.
- The Chat Adapter rejects browser-origin requests and exposes only its
  authenticated `POST /chat` contract plus readiness checks.
- Local managed files use owner-only POSIX permissions or the verified
  current-account Windows DACL. Symlinks and unmanaged target directories are
  rejected. Docker operations are pinned to the attested local daemon.
- Each install uses a random Compose project identity and matching ownership
  labels. Lifecycle locks verify process identity; ambiguous ownership fails
  closed.

### Local model companion

The provider-free local-model service is separate from SIWC and n8n AI
Assistant. Its OpenAI-compatible API has no authentication: any container on
the selected Docker network can make model and management requests. Treat that
network and its containers as trusted. The service publishes no host port or
reverse-proxy route. This is not isolation from the host/root administrator or
trusted network peers.

The manual Render alternative has a different boundary: same-workspace/region
private services and their allowed environment connectivity. It is not managed
by this SSH installer. The ignored key placeholder still is not authentication.
See [Hosting compatibility](hosting-compatibility.md#render-manual-private-model-service).

Ollama cloud features are disabled, but this does not make setup offline. Docker
must download the pinned runtime image and the model weights from their
registries. No provider key or OAuth credential is used by this model flow.

The model cache is kept in its owned volume across runtime restart/retry;
Ollama startup pruning is disabled so partial pull data is not removed merely
because the runtime restarts. This does not guarantee that an interrupted
transfer resumes from its previous byte, and retained data uses disk space.
Cache deletion requires a separate reviewed confirmation; ordinary retry does
not clear it. The runtime uses a read-only root filesystem, drops Linux
capabilities, and has bounded memory, CPU, process, temporary-storage, and log
limits.

The catalog records each model's reviewed registry manifest SHA-256 digest and
quantization. The acquisition helper verifies both before inference and
model-ready status, including on first install; if an upstream mutable tag
points to different content, the operation fails instead of accepting or
automatically substituting the new content.

### AI Assistant companion image integrity

The generated AI Assistant companion uses reviewed, immutable
`tag@sha256:<OCI-index-digest>` image references for its API/certificate image,
privileged runner, nested sandbox image, and optional SearXNG service. The
Compose format cannot enforce image provenance itself, so the source-level
regression guard forbids floating or digestless production references,
including the nested `SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE` value.

There is no automatic remote upgrade. An upgrade or rollback is a separately
confirmed managed companion update after read-only discovery and exact-plan
review; it must preserve the no-n8n-mutation boundary, ownership attestation,
and no-host-port verification. See the exact procedure in
[maintenance.md](maintenance.md#updating-or-rolling-back-ai-assistant-companion-images).

### In-wizard Chat Adapter tester

The Ready screen's Chat Adapter tester is a deliberately narrow convenience
path, not a browser CORS exception. Its browser calls stay same-origin to the
setup-token-protected wizard. Only the local wizard server calls the adapter,
using a server-side `POST /chat` request without an `Origin` header.

The tester accepts only a literal `http://127.0.0.1:PORT` base URL and appends
`/chat` itself. It refuses `localhost`, IPv6, LAN/private/public addresses,
credentials, query strings, fragments, redirects, malformed JSON, oversized
payloads, excessive IDs/ciphertext, concurrent key use, and preview mode. The
server bounds timeout and response size, validates the upstream shape, and
returns only a conversation ID plus output with generic redacted errors.

Before a test, the browser obtains an ephemeral RSA-OAEP SHA-256 public key
from the local wizard, clears the credential input, and retains only ciphertext
and key ID in page memory. The matching private key remains only in the local
server's in-memory, time-limited, bounded session map and can be invalidated
explicitly. Prompts and transcript are not persisted server-side.

The Test AI Chat interface distinguishes connection setup, waiting for the
first text, active streaming, completion, interruption, and failure. Its atomic
status announcement changes only when the phase changes, while the transcript
keeps partial text visible without announcing each streamed chunk. Stopping the
test uses the relay's existing abort path and preserves text already received.
This UI behavior does not change the adapter's authenticated `POST /chat` SSE
contract or the behavior seen by external clients such as n8n.

This is not encryption at rest or end-to-end encryption. It reduces accidental
credential transit and storage exposure, but cannot protect a compromised
browser, extension, or local machine.

## What “private” means here

Port `10531` is not reachable from the public internet or VPS host through a
Docker port mapping. It is reachable by containers attached to the selected
Docker network.

The bridge must listen on `0.0.0.0` inside its container so n8n can reach it.
The upstream warning about a non-loopback host is therefore expected. The
protection is the absence of `ports:` and Traefik labels.

Do not attach untrusted containers to the same Docker network.

## Credential consequences

The protected SIWC registration contains the local provider session needed for
plan use. The local operating-system account, Docker runtime, selected
installation, and on VPS the authorized host administrator are access
boundaries. A compromised local account, Docker host, or destination runtime
can expose credentials in its storage. Keep a separate backup of n8n data and
never put tokens or one-time Relmio bearers in issues, logs, screenshots,
browser code, or support messages.

Local client credentials and the OpenAI session have different jobs:

- The raw Codex App Server bearer grants a trusted local client access to its
  high-trust interface.
- The Chat Adapter bearer authorizes its narrower read-only chat API.
- The n8n bearer authorizes one private sidecar. It is not a provider token.
- OpenAI access and refresh tokens stay in the selected protected SIWC
  registration and are never returned to browser JavaScript.
- With the image add-on on, a separate Codex access and refresh token stays in
  the sidecar's protected store and is used only for image requests. It is
  never returned to browser JavaScript or n8n.
- Do not expose local endpoints on a LAN, public IP, domain, reverse proxy, or
  hosted service. Keep each bearer in the trusted client that needs it.
- If a local bearer is disclosed, use the offered ownership-checked
  maintenance action. If the provider session may be exposed, sign out from
  the owning installation and follow ChatGPT's disconnection controls.

## Codex image add-on

The optional image add-on signs in a second time, with OpenAI's Codex
device-code flow and the Codex CLI's public client ID
(`app_EMoamEEZ73f0CkXaXp7hrann`), the way Hermes Agent's "OpenAI (Codex
auth)" provider does. It is not Sign in with ChatGPT. OpenAI does not
document this image route for other apps, so it can stop working without
notice, and Relmio does not claim OpenAI approval for it. Images count against
the plan's Codex limits. Owner-facing setup is in
[Turn on image generation on a VPS](vps-and-n8n.md#turn-on-image-generation-optional)
and [on this computer](local-endpoints.md#turn-on-image-generation-optional).

- **Stores:** on the VPS, `/docker/n8n-openai-oauth/siwc/codex-images` holds
  the Codex access and refresh tokens, the ChatGPT account ID, email, plan type
  and token expiry. The ID token is not stored. While a sign-in is pending it
  also holds the device code, which expires after 15 minutes. The folder is
  `0700`, the files are `0600` and owned by the sidecar user, and symlinks,
  hard links and group or other permissions are refused. Root on the VPS,
  and any backup of that folder, can read the refresh token.
  On this computer, the sidecar's `siwc-store` Docker volume holds the same
  files under `codex-images`. Administrators and Docker users on this
  computer, and any backup of Docker's data, can read the refresh token.
  Signing out of ChatGPT or removing the sidecar signs out of images first.
  If that sign-out does not finish, removal stops and keeps the volume so you
  can try again; if OpenAI does not confirm the revocation, the dashboard says
  so and removal still deletes the volume. Anyone who can run workflows in
  that n8n can make images with the account.
- **Transmits:** sign-in, token exchange, refresh and revocation go to
  `https://auth.openai.com`. Image requests go to
  `https://chatgpt.com/backend-api/codex/images/generations` or
  `/images/edits` with the Codex access token, the account ID, the prompt and
  any input images, and identify as `originator: relmio`. The ChatGPT plan
  token is never sent to this route, and the Codex token is never used for
  text.
- **Returns to the wizard or dashboard:** only the sign-in state, email, plan
  type, the last six characters of the account ID, and the pending code with
  its verification page. Tokens and the device code's internal ID stay in the
  sidecar's store. On this computer, the dashboard runs the add-on's CLI with
  `docker compose exec` in the owned running sidecar and reads only its
  one-line status.
- **Logs:** the sidecar's image errors are fixed text. Tokens, prompts and
  image data are removed from any error it passes on.
- **Refresh:** Relmio treats refresh tokens as single use and marks a
  refresh as in progress before sending it. If OpenAI rejects the token as
  expired, reused or invalid, or the outcome is unknown, the add-on needs a
  new image sign-in; the old token is never retried. Other refresh errors
  keep the sign-in and return `images_unavailable`.
- **Sign-out:** deletes the files and asks OpenAI to revoke the refresh
  token, waiting up to 10 seconds. An unconfirmed revocation is reported. It
  is unknown whether revoking also affects other Codex sign-ins on the same
  account. **Sign out and revoke** for the ChatGPT session first signs out of
  images too, as a best effort. Locally, removing the sidecar does the same,
  and the dashboard reports the image revocation result for both. **Pause
  plan use** keeps the image sign-in.
  Leftover temporary record files are removed on image sign-out.
- **Unknown:** the scopes OpenAI grants to these tokens, their lifetimes, and
  OpenAI's own limits on image size, count and prompt length.

## Model discovery and checks

The n8n sidecar finds the account's text models itself. Owner-facing behavior
is in [Model discovery and checks](n8n-configuration.md#model-discovery-and-checks).

- **Transmits:** to choose the catalog version, the sidecar sends a `GET` to
  `https://registry.npmjs.org/@openai/codex/latest` about every 12 hours, when
  it fetches the catalog for n8n or for turning checks on, with checks on or
  off. It carries no token, account data or prompt; npm sees the sidecar
  host's IP address and the request time. The catalog request to
  `https://api.openai.com/v1/models` uses the selected registration's token,
  as before. With model checks on, each test is a `POST` to
  `https://api.openai.com/v1/responses` with that token, the instruction
  `Reply with OK.` and the input `OK`.
- **Stores:** `model-checks/<registration ID>.json` in the sidecar's SIWC
  storage (`/docker/n8n-openai-oauth/siwc/model-checks` on a VPS). It records
  whether checks are on, your consent time and notice version, each model's
  result, time, whether a test or a real request produced it and OpenAI's
  error code, and the last Codex version read from npm with its time. It holds
  no tokens, prompts or responses. The folder is `0700` and files are `0600`,
  owned by the sidecar user. Symlinks, hard links and group or other
  permissions are refused, writes are atomic under a lock file, and an unsafe
  record is never overwritten. Turning checks off can replace a safe record
  that fails to parse. Turning checks off removes the consent but keeps the
  results.
- **Returns to the wizard:** up to 64 model rows (ID, name, state, whether
  n8n sees it, check time), whether checks are on, the catalog time and
  version, and the last run's counts and stop reason. Tokens, OpenAI error
  text and remote command errors stay on the server.
- **Logs:** discovery and checks add no log lines.
- **Consent:** tests use the plan, so they run only after you confirm them for
  that server. Checks count as on only while the recorded consent matches the
  current notice; an approval of an older notice reads as off. Status checks
  send no test request, make no npm request and write nothing to the record;
  reading the catalog can still refresh the SIWC token. Stopping the sidecar
  stops any check in progress.

## Request counts

The n8n sidecar counts the text requests it relays for **Plan and usage**.
Model-check tests and image requests are not counted, and ChatGPT measures
plan usage its own way. Relmio shows no plan percent, reset time or credits;
they stay in ChatGPT under [Manage usage](https://chatgpt.com/settings/usage).

- **Records:** each `/v1/responses` or `/v1/chat/completions` request the
  sidecar relays to OpenAI counts once, under its UTC day and model, with how
  it ended: completed, failed or incomplete. A request the client abandons,
  or one that fails because the client cancelled it, counts with no outcome.
  Completed responses add the input, cached input, output, reasoning and
  total token counts from `response.completed.usage`. Image requests,
  model-check tests and requests the sidecar rejects before sending are not
  counted. A model keeps its ID only when the request completed or ended
  incomplete, or when the catalog the sidecar last loaded lists it. Anything
  else counts as `other`, so a typo or a pasted key is never stored. The
  sidecar also keeps the time and code of the last plan-usage error
  (`subscription_sharing_usage_limit_exceeded`,
  `subscription_sharing_usage_unavailable`,
  `subscription_sharing_user_unavailable` or
  `subscription_sharing_user_not_eligible`), whether it arrived before or
  during a stream. The next completed response clears it.
- **Stores:** `activity/<registration ID>.json` next to the model-check record
  (`/docker/n8n-openai-oauth/siwc/activity` on a VPS, the sidecar's
  `siwc-store` Docker volume on a local install). Each write keeps only the
  31 most recent UTC days and at most 64 named models per day; the rest count
  as `other`. Nothing else deletes the file. Signing out keeps it, and after
  the last request the counts stay until the sidecar's storage is removed.
  On this computer, removing the sidecar, which needs sign-out first, deletes
  its `siwc-store` volume and the counts with it.
  Counts are whole numbers. It holds no prompts, outputs, request IDs, IP
  addresses, headers or tokens. The sidecar writes at most once every 30
  seconds and once when it stops, so a crash can lose the last 30 seconds of
  counts. Folder and file modes, ownership and link checks, atomic writes and
  the lock file work as for the model-check record. The next write replaces a
  safe record that fails to parse; an unsafe record is never touched. A failed
  write never affects a request.
- **Transmits:** nothing. Counting adds no network request.
- **Returns to the wizard:** when you press **Refresh usage**, or open Plan
  and usage on this computer, the sidecar's read-only `usage` command prints
  the stored record. On a VPS it runs over the reviewed SSH connection. It
  needs the approved direct-root session, a **Check installed account** from
  the last five minutes for the same n8n container and network, and a
  running sidecar for that account, and the wizard allows 10 reads in 15
  minutes. On this computer it runs through `docker compose exec` after
  Relmio confirms that it owns the running sidecar. The wizard checks every
  field and returns only the last 30 UTC days: totals, active days, the peak
  day, requests and tokens per day, up to 64 models plus `other`, and the
  last plan-usage event with its recovery. A record that fails any check, or
  a `usage` command that fails, shows as `unavailable` with no partial
  counts. The view says `empty` when nothing was counted in the last 30 days,
  and for a sidecar built before request counting, which has no `usage`
  command and counts nothing until it is updated; on a VPS, use **Review
  sidecar update**.
- **Logs:** counting adds no log lines.
- **Notice:** before you approve, the VPS install review lists "Keep 31 days
  of request and token counts here" and gives the details under **Host key,
  build and request count details**. The sidecar review on this computer and
  the VPS sidecar update summary say that the sidecar keeps daily request and
  token counts for 31 days, with no prompts or answers.

## Remembered Responses items

The n8n sidecar keeps some output from completed Responses requests, so that a
later request can refer to it by ID. n8n's AI Assistant does this in tool
steps and follow-up messages. Owner-facing behavior is in
[AI Assistant requests](n8n-configuration.md#ai-assistant-requests).

- **Stores:** in the sidecar process's memory only, never on disk. From each
  `/v1/responses` request that reaches `response.completed`, it keeps
  reasoning items (OpenAI's encrypted reasoning as received, and the
  reasoning summary) and assistant messages (output text and `phase`).
  Failed, incomplete or interrupted responses and Chat Completions requests
  add nothing. It holds at most 4,096 items and 32 MiB, keeps each item for up
  to 6 hours and drops the least recently used first. A restart or update
  empties it.
- **Transmits:** a kept item goes only to
  `https://api.openai.com/v1/responses`, with the selected registration's
  token, as input to a later request that refers to its ID. Responses
  requests that set `reasoning` ask OpenAI for `reasoning.encrypted_content`,
  so those clients, such as n8n's Assistant, also receive the encrypted
  reasoning that OpenAI returns. Only reasoning items that carry it are kept.
- **Returns to the wizard:** nothing. Callers get OpenAI's response, not the
  kept items.
- **Logs:** the memory adds no log lines.

Every caller that holds the sidecar's Relmio key shares this memory. A caller
that knows an item ID can have that item added to its own request, and the
model may repeat its content. Share the key only with trusted callers.

## Product and policy limitations

- ChatGPT sign-in is not an OpenAI Platform API key. SIWC plan permission is a
  separate ChatGPT grant and does not add Platform API credits.
- Account eligibility, workspace policy, serving-host admission, model
  availability, and successful requests remain separate checks.
- The local gateway uses the selected registration only. It does not switch
  accounts or fall back to another provider or billing path.
- Audio, video, Files API management, moderation, stored
  responses/conversations, and unsupported request parameters are not
  enabled in the current plan gateway. Image generation and editing work only
  through the optional Codex image add-on above, never through the ChatGPT
  sign-in.
- The App Server child receives its short-lived access token in `ACCESS_TOKEN`.
  A trusted high-trust tool running as the same OS user can inspect its own
  process environment or files. Relmio does not claim an OS boundary that
  prevents an authorized native client or its tools from exposing their own
  process data.
- OpenAI can change service behavior and applies its account, workspace,
  usage-policy, and Terms requirements.

These code limits are not additional commercial or partner requirements for
the documented local open-source SIWC flow: it needs no commercial approval,
partner-issued client ID, or client secret. The user still separately grants
ChatGPT plan use. Account eligibility and applicable Terms remain distinct;
the VPS token-storage question is unresolved. See the
[2026-10-05 source check](openai-source-check-2026-10-05.md).

### Policy evidence and scope

The [current source check](openai-source-check-2026-10-05.md) records the
official SIWC and plan-usage sources together with the corresponding local
implementation and open questions:

| Recorded source finding | Scope |
| --- | --- |
| The local open-source SIWC flow uses dynamic registration, protected local storage, a verified identity, a separate ChatGPT plan grant, and the public Responses API. No commercial approval, partner client ID, or client secret is required. | Local/self-hosted documented flow only; eligibility, requested/granted plan permission, model access, and successful inference remain separate checks. |
| The website's `/api/chat` returns `410 Gone`; the local path does not enable it. OpenAI's public cookbook request-access note applies to paid or remotely hosted apps. | Hosted site work is outside this migration. |
| OpenAI's self-hosted VM guide and SIWC Terms do not resolve persistent remote token storage. | No provider-approval claim is made for VPS token transfer/storage. |
| SIWC Terms §2 limits use to the connected application and rules out general-purpose API access for other tools. Relmio is not listed in OpenAI's partner directory. | Whether an OpenAI-compatible endpoint for n8n fits §2, and whether Relmio counts as a supported open-source tool, are open questions for OpenAI. |

These findings are source observations, not legal advice, runtime acceptance,
or an interpretation of an owner's separate hosted application.

Relmio applies the documented distinctions as engineering controls:

- The local open-source path uses SIWC registration and plan consent; it does
  not require a commercial approval or partner credential.
- The direct Codex client and read-only Chat Adapter remain separate local
  contracts; the raw App Server route is high trust.
- The n8n SIWC sidecar uses the selected registration and public Responses API
  behind its own private-network bearer.
- The n8n AI Assistant's **OpenAI** provider uses an operator's Platform API
  key entered directly in n8n; Relmio never receives it. Pointing the
  Assistant at the SIWC sidecar is the owner's choice and stays open under
  SIWC Terms §2. It passed one live test on 2026-10-07, on one account and
  model; see [AI Assistant](ai-assistant.md#optional-chatgpt-plan-sidecar).
- Consent to background workflow use is separate from the ChatGPT plan grant.

This security page does not establish live account eligibility or turn the
website's disabled `/api/chat` or unresolved VPS token-storage question into a
supported path. See the dated source check for reviewed official sources and
implementation evidence. Applicable OpenAI Terms remain the account owner's
responsibility.

## Dependency policy

The current package requires Node.js 24 or newer and pins `jose` `6.2.12`,
`ws` `8.22.0`, and `ssh2` `1.17.0`. The SIWC runtime collector packages an
explicit source allowlist with a generated lock for pinned runtime
dependencies. Do not substitute moving package versions or include credentials
in a build context. Follow the upgrade checklist in [maintenance.md](maintenance.md).

## Reporting a security problem

Do not open a public issue containing a token, password, private IP, hostname,
workflow data, or unredacted log. Revoke exposed credentials first, then share
only a sanitized reproduction with the repository owner.

## 2026-09-26 OpenAI source check

**Historical implementation record:** this source check describes the former
Codex credential-copy sidecar, not the current local SIWC implementation. See
[the 2026-10-05 source check](openai-source-check-2026-10-05.md) for current
source observations. The earlier findings remain historical permission and
retention evidence; they do not establish current approval.

**Scope and method.** Official OpenAI authentication, capability, Terms and
privacy pages were reviewed on 2026-09-26 against the existing OpenAI OAuth
bridge implementation and its user disclosures. This was source and local
code inspection only: no sign-in, credential access, provider API request,
host inspection, deployment or runtime capability test. Findings below
describe the code path, not OpenAI approval. The review is distinct from
identity authentication, separately authorized permissions, model/TTS
capability, deployment consent and hosting-provider approval.

### Identity, permissions, and capability findings

OpenAI's [Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
describes partner identity sharing as the user's name, email and optional
profile picture. It says additional access requires separate authorization.
Relmio's n8n bridge is not that identity-only flow: after the user starts
official host-side Codex CLI sign-in, Relmio reads and copies the complete
Codex `auth.json`, including access/refresh credential fields. The article
does not grant that full-credential copy, transport, scope or API permission.
The official [Codex authentication documentation](https://learn.chatgpt.com/docs/auth)
documents file-based `auth.json` and copying a Codex cache to headless
machines/containers, while recommending API keys for automation; it does not
specifically authorize Relmio's third-party n8n-compatible transport.

OpenAI's [API authentication documentation](https://developers.openai.com/api/reference/overview#authentication)
describes Platform API keys or short-lived workload identity for API
authentication. This bridge is neither: ChatGPT/Codex sign-in is not an
OpenAI Platform API key, does not create API credits, and does not bypass
account limits. The existing n8n recipe only exposes capabilities implemented
by the pinned third-party OAuth runtime. Model listing is not account
entitlement or successful completion. The image add-on offers only
`gpt-image-2`: the Codex image route ignores the model ID, so earlier Flare and
Sunburst listings never selected those models. Audio/TTS, transcription, translation, Live and
Realtime are not implemented through this bridge. The
[Audio speech documentation](https://developers.openai.com/api/docs/guides/text-to-speech)
and [image-generation documentation](https://developers.openai.com/api/docs/guides/image-generation)
describe Platform API capabilities; they do not establish subscription-bridge
entitlement. OpenAI's [video API deprecation notice](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api)
records that Sora 2 and the Videos API shut down on 2026-09-24 with no
replacement; do not treat a separate Platform connection as a currently
available video workaround.

The reviewed [Terms of Use](https://openai.com/policies/terms-of-use/),
[EU Terms](https://openai.com/policies/eu-terms-of-use/),
[Services Agreement](https://openai.com/policies/services-agreement/),
[Service Terms](https://openai.com/policies/service-terms/) and
[Usage Policies](https://openai.com/policies/usage-policies/) include
restrictions concerning sharing account access, programmatic extraction and
circumventing limits or safeguards. The Services Agreement permits API
integration only subject to that agreement and separately restricts sharing
individual account credentials and bypassing usage limits. Service Terms also
contain service-specific rules; ChatGPT Voice restrictions are distinct from
API text-to-speech. Regional Terms apply according to the user's residence,
not merely the VPS location. These findings do not constitute a blanket
compliance or violation determination for this implementation; applicability,
account/workspace permission and permission for this exact compatibility
transport remain unresolved. Provider hosting capability and a wizard's final
deployment confirmation are not OpenAI permission.
The official [API data-control documentation](https://developers.openai.com/api/docs/guides/your-data)
says API content is not used for training by default unless the customer opts
in; default abuse-monitoring retention may be up to 30 days, with endpoint and
legal/security exceptions, and Zero Data Retention or Modified Abuse
Monitoring requires approval. These are API endpoint controls and must not be
applied automatically to this ChatGPT/Codex subscription bridge.
The [Services Communications Privacy Policy](https://openai.com/policies/services-communications-privacy-policy/)
and [EU Privacy Policy](https://openai.com/policies/eu-privacy-policy/) describe
account/content/log data, recipient categories, retention and international
processing. They do not establish account-specific onward disclosures or
where this bridge's requests are processed. Region eligibility remains
separately conditional on the official [ChatGPT supported countries](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries)
and [API supported countries](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories).

### Observed reads, storage, transmission, and logs

These are the observed paths in the reviewed implementation; platform
administrators, retention and actual runtime logs are not fully observable
from source inspection.

| Stage | Observed behavior and parties |
|---|---|
| Read | Host-side official Codex login writes to an attempt-specific `CODEX_HOME`; Relmio reads the full JSON from `N8N_OPENAI_OAUTH_HOME/auth.json` or `~/.n8n-openai-oauth/auth.json`. This includes access and refresh tokens and account metadata, not merely identity fields. The sidecar and third-party runtime read token/account claims, refresh metadata and incoming n8n request bodies. |
| Store | Host credential directories are mode 0700; staged/promoted files mode 0600. Local setup keeps the source credential on the host and seeds a private `oauth-auth` Docker volume at `/home/node/.codex/auth.json`. The VPS path SFTPs the complete JSON to `/docker/n8n-openai-oauth/auth/auth.json` mode 0600 and bind-mounts it to the sidecar. The third-party runtime can refresh and rewrite its copy; secret read-only injection alone is insufficient. Refresh can retain rollback/quiesce snapshots; cleanup is best-effort. |
| Transmit | The user initiates browser/Codex authentication with OpenAI services; the host Codex login produces the full credential read by Relmio. After explicit local/VPS review, credential bytes go to the local Docker daemon/volume or to the selected VPS SSH/SFTP endpoint and its sidecar. Supported n8n prompts, messages, tool data and inline inputs travel from n8n through the sidecar/dependency to `chatgpt.com/backend-api/codex` with access-token bearer and account ID; refresh requests go to `auth.openai.com/oauth/token`. Responses return to the sidecar and n8n/client. |
| Other network recipients | Building the sidecar installs the pinned package via npm/Node/package-image infrastructure. That third-party runtime's model discovery also requested `registry.npmjs.org/@openai/codex/latest` without an OpenAI bearer. The current SIWC sidecar makes its own npm check; see [Model discovery and checks](#model-discovery-and-checks). These are separate from model inference. |
| Logs | Host Codex stdout/stderr is bounded and captured in memory; login failures map to fixed messages. Current Codex documentation describes `codex-login.log` for direct `codex login` runs, but applicability to the pinned `@openai/codex` 0.154.0 and log retention are unknown. The one-shot local credential-seed helper disables Docker logging. The main sidecar does not set an explicit Docker log driver. The dependency can log request summaries/timings/usage/errors if logging is enabled; Relmio does not enable its request logger. Actual n8n, Docker, SSH, provider, backup and OpenAI retention/log behavior was not inspected, so do not claim that nothing is logged or retained. Dependency errors may include upstream text. |
| Additional access boundary | **[INFERENCE]** Destination root/platform administrators, storage, backups and log services are additional potential access boundaries. Source inspection does not show that any particular employee or package author received credentials; provider-specific retention and operator access are unknown. |

The host invocation did not supply OAuth scopes, and Relmio does not inspect
requested/granted scopes. The dependency's own default `openid profile email
offline_access` is not proof of the official Codex login's requested or
granted scopes. Actual scopes, account/workspace constraints, credential
retention, runtime package bytes, model access and provider-side log retention
remain unknown. Direct API data-retention guarantees must not be assumed for
this bridge. Keep the bridge private, same-owner and experimental; never pool
or share credentials, bypass limits, or place them in a planner artifact.

### 2026-09-27 OpenAI and hosting source review

**Historical source review:** this OpenAI review predates the current local
SIWC implementation. Its bridge and permission observations describe the
former credential-copy route, not current runtime behavior. See the
[2026-10-05 SIWC source check](openai-source-check-2026-10-05.md) for current
implementation evidence and unresolved hosted/VM requirements.


**Scope and method.** On 2026-09-27, current official OpenAI material and local
source were reviewed for the existing ChatGPT/Codex n8n bridge, the noncredential
hosting planner, manual model/search/Daytona handoffs, and restricted
Chat-Completions relays. This is a public-source and code review, not legal
advice, OpenAI approval, account-entitlement verification, or provider-runtime
acceptance. No new provider, model, relay, search, Daytona, or TTS runtime was
tested. Source links and findings follow; page dates are given as shown by each
source where available.

#### Official sources checked

- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
  (Help Center displayed “Updated: 4 hours ago” on 2026-09-27): describes
  supported-partner identity fields (name, email, optional profile picture);
  additional access requires separate authorization. It does not establish
  that Relmio's host-side Codex credential-copy bridge is that identity flow.
- [Codex authentication](https://learn.chatgpt.com/docs/auth) and
  [Codex models](https://learn.chatgpt.com/docs/models) (no page date shown):
  document Codex credential/cache handling, recommend API keys as the default
  for automation, and describe model availability as dependent on rollout,
  sign-in method, client, plan, and workspace. The authentication guide also
  documents `codex-login.log` for direct `codex login` runs. It does not grant
  blanket permission to use a Codex subscription credential through this
  bridge or establish logging behavior for the pinned `@openai/codex` 0.154.0.
- [API authentication](https://developers.openai.com/api/reference/overview#authentication),
  [API data controls](https://developers.openai.com/api/docs/guides/your-data),
  [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech),
  and [Image generation](https://developers.openai.com/api/docs/guides/image-generation)
  (no page dates shown): describe API-key/workload-identity authentication,
  API-specific data controls, and separate Audio/Image API capabilities. Those
  controls or capabilities cannot be assumed for this subscription bridge.
  The API data-controls guide says API content is not used for model training by
  default absent customer opt-in; default abuse-monitoring logs can contain
  prompts/responses for up to 30 days, subject to stated exceptions, while
  Zero Data Retention and Modified Abuse Monitoring require approval. These
  API-specific terms do not automatically govern the subscription bridge,
  intervening hosting relays, or their logs.
- [API deprecations](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api)
  (notice dated 2026-03-24): Sora 2 and the Videos API shut down on 2026-09-24
  with no replacement listed; a separate Platform connection is not a current
  video workaround.
- [Terms of Use](https://openai.com/policies/terms-of-use/),
  [Europe Terms](https://openai.com/policies/eu-terms-of-use/),
  [Services Agreement](https://openai.com/policies/services-agreement/),
  [Service Terms](https://openai.com/policies/service-terms/), and
  [Usage Policies](https://openai.com/policies/usage-policies/) (Terms effective
  2026-01-01; Services Agreement updated 2025-12-01/effective 2026-01-01;
  Service Terms updated 2026-09-21; Usage Policies effective 2025-10-29):
  restrictions on account/credential sharing, programmatic extraction, and
  bypassing limits or safeguards remain material. The exact permissibility of
  this bridge is unresolved; a deployment confirmation or experimental label
  does not answer it.
- [Services Communications Privacy Policy](https://openai.com/policies/services-communications-privacy-policy/)
  and [Europe Privacy Policy](https://openai.com/policies/eu-privacy-policy/)
  (updated 2026-07-30 and 2026-08-24, respectively), plus
  [ChatGPT supported countries](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries)
  and [API supported countries](https://help.openai.com/en/articles/5347006-openai-api-supported-countries-and-territories/)
  (Help Center displayed “Updated: 2 months ago” and “Updated: last month”):
  describe regional privacy/eligibility boundaries but do not establish an
  account's actual processing location or eligibility.

#### Findings by flow

- **Identity and grants:** The Help Center's supported-partner flow is
  identity-sharing, whereas the existing bridge starts Codex login on the
  operator's host and copies the complete `auth.json` to a selected local
  Docker volume or VPS over Docker stdin/SFTP. The wizard confirmation approves
  that deployment action, not a provider grant. Relmio does not pass or inspect
  the actual requested/granted scopes. The Codex documentation's cache-copy
  pattern is not blanket approval for this separate third-party transport.
- **Planner generation:** The browser submits provider/component identifiers,
  deployment/profile metadata, and an authenticated same-origin session to
  Relmio's local `/api/hosting/plan`. The server renders artifacts without
  contacting provider accounts or persisting a plan. The browser keeps the
  current plan and downloads files/ZIPs to the operator's computer. At
  generation time the identifiable processing parties are the local browser
  and Relmio server; clicking source links is a separate browser request.
- **Operator-deployed relay:** The generated relay accepts a bounded JSON body
  with minimal `model`/`messages` checks but forwards the entire accepted body.
  It reads caller and upstream bearer secrets from server-side runtime secret
  storage, sends the upstream bearer plus request body only to the fixed
  configured HTTPS `/v1/chat/completions` origin, and returns successful
  JSON/SSE content to the caller. It does not introspect the upstream
  credential's type, provenance, or permission, or enforce `store=false`,
  text-only payloads, tool permissions, or provider-model limits. Do not
  configure it with ChatGPT/Codex/SuperGrok session credentials; use an
  independently authorized upstream API credential.
- **Cloudflare and search telemetry:** Generated Cloudflare relay artifacts
  enable observability logs with `head_sampling_rate: 0.1` and traces with
  `head_sampling_rate: 0.01`. The Cloudflare search route carries `q` in its
  URL and also enables logs/traces. These settings mean queries and request
  processing must not be described as “no logs” or “all data stays local.”
  Exact fields captured, downstream log recipients, and retention are unknown.
- **Models and runtime recipients:** Manual local-model profiles use Ollama
  with `OLLAMA_NO_CLOUD=1`; this disables Ollama cloud inference, not runtime
  image/model downloads or network use by n8n tools. Prompts go to the selected
  model runtime; n8n may retain executions. Search queries may be sent to
  configured search engines. Later deployed recipients include n8n/callers,
  selected hosting and storage services, runtime/image/model registries, and
  configured model/search providers. Planner generation itself makes none of
  those deployment or inference calls.
  For an operator-configured Daytona handoff, the later sandbox and separately
  configured model provider receive the workflow/tool inputs; the operator
  supplies those credentials in n8n's runtime secret store. Plan generation
  does not contact either service.

No new OpenAI scope or credential-copy path is added by the planner or
generated relay. A deliberately OpenAI-API-backed relay must still use a
separately authorized API credential and follow the user's applicable terms;
this is not blanket permission for all upstreams. New provider deployments,
model output, throughput, search, Daytona, provider entitlement, and TTS remain
**NOT-RUN**. Actual platform log contents/retention, n8n execution retention,
account-specific data controls, onward disclosures, scopes, and permission for
the existing subscription bridge remain unknown. See
[Hosting compatibility](hosting-compatibility.md) for operational boundaries.

## 2026-09-27 local-model attestation source check

**Historical source check:** the OpenAI findings below describe the local-model
change at that date, not the current ChatGPT plan sidecar. See
[the 2026-10-05 source check](openai-source-check-2026-10-05.md) for current
SIWC behavior and unresolved provider questions.

**Scope and method.** The current official [Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt),
[Codex authentication guide](https://learn.chatgpt.com/docs/auth),
[API authentication documentation](https://developers.openai.com/api/reference/overview#authentication),
[Codex models guide](https://learn.chatgpt.com/docs/models),
[local-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers),
[Terms of Use](https://openai.com/policies/terms-of-use/),
[Services Agreement](https://openai.com/policies/services-agreement/),
[Service Terms](https://openai.com/policies/service-terms/),
[Privacy Policy](https://openai.com/policies/privacy-policy/),
[API data controls](https://developers.openai.com/api/docs/guides/your-data), and
[Text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)
were reviewed on 2026-09-27. This source and code review made no sign-in,
credential access, provider API request, SSH, remote change, test, build, or
live workflow request. Docker's [security-opt documentation](https://docs.docker.com/reference/cli/docker/container/run/#security-opt)
and the [Moby 28.5.2 option parser](https://github.com/moby/moby/blob/v28.5.2/daemon/daemon_unix.go#L215-L270)
were separately checked for Docker's enabled spellings. They show that bare,
`=`, and legacy `:` forms can express enabled `no-new-privileges`; the Relmio
attestation deliberately accepts only bare, `:true`, and `=true`, rejecting
missing, disabled, malformed, or contradictory entries. Conflicts fail closed
regardless of entry order. This Docker compatibility finding is not an OpenAI
permission or capability finding.

**OpenAI findings and unknowns.** ChatGPT identity sign-in remains distinct
from the existing credential-copy bridge; it does not grant bridge permission.
The local-model flow uses no OpenAI sign-in, API key, or OAuth scope, and the
review found no changed OpenAI recipient or capability. The documentation
does not establish permission for the separate compatibility bridge, access
to any OpenAI model or TTS, or account/workspace entitlement. Exact
provider-side retention, host and registry logs, deployment-specific
recipients, and account-specific permission remain unknown; OpenAI API data
controls do not establish retention for this local-model flow.

**Local-model data flow observed in source.** Relmio reads Docker/n8n/network
identity, capacity, ownership metadata, container configuration/security
options, hashes, and bounded acquisition status; Docker inspection internally
parses full container JSON, which may include environment secrets even though
the selected values are used for attestation. It stores owner-only local
runtime assets and metadata under the validated Relmio home, or VPS assets and
metadata under `/docker/n8n-openai-oauth/local-model`, plus the model cache in
an owned Docker volume. Reviewed browser choices and status pass through the
Relmio server; local operations reach the selected Docker daemon and VPS
operations use the selected SSH transport. Runtime/helper images and weights
are fetched from registries; the helper contacts the private
`http://n8n-local-model:11434` endpoint for the selected model and fixed
arithmetic probe without an authorization header. Workflow inference uses the
private n8n-to-Ollama endpoint, not an OpenAI-hosted endpoint. The helper emits
allowlisted status fields and bounded logs, but actual Ollama logs, n8n
execution history, host/SSH/sudo audits, backups, and registry mirrors or CDN
recipients are not established by this review. Trusted network peers and host
administrators remain within the trust boundary.

Container readiness and the helper arithmetic inference check are not an
acceptance test for a fresh n8n workflow or evidence of general model quality.
The initial manual workflow request with `reasoning_effort: none` and a
32-token limit returned `2` and failed the exact-`4` assertion. A subsequent
request using the same natural-language `2+2` prompt and exact assertion with
`reasoning_effort: medium` and a 512-token limit passed in 5.653 seconds. This
is one workflow acceptance result, not evidence of general model quality. No
live acceptance for another provider is established by this source check.

## 2026-09-27 builder-selector compatibility and OpenAI source check

**Historical source check:** the OpenAI findings below describe the selector
change and prior credential-copy bridge, not current SIWC plan use. See
[the 2026-10-05 source check](openai-source-check-2026-10-05.md) for the
current implementation record.

**Scope and source review.** On 2026-09-27, the official OpenAI
[Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt),
[Codex authentication guide](https://learn.chatgpt.com/docs/auth),
[API authentication reference](https://developers.openai.com/api/reference/overview#authentication),
[Codex models guide](https://learn.chatgpt.com/docs/models),
[Codex local-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers),
[Terms of Use](https://openai.com/policies/terms-of-use/),
[Services Agreement](https://openai.com/policies/services-agreement/),
[Service Terms](https://openai.com/policies/service-terms/),
[Privacy Policy](https://openai.com/policies/privacy-policy/),
[API data controls](https://developers.openai.com/api/docs/guides/your-data), and
[Text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech)
were fetched again. The identity article describes partner identity fields,
not Relmio's separate host-side Codex credential-copy bridge; additional access
requires separate authorization. Codex cache documentation is not blanket
permission for that bridge. API authentication and API-specific retention
controls do not establish the bridge's scopes, permission, retention, or
recipient behavior. Terms and account eligibility remain unresolved; this is
not legal advice or an OpenAI approval. The current local-model workflow and
manual n8n workflow acceptance for this private fix are **NOT-RUN**.

**Changed selector boundary.** The local read-only attestor accepts a present,
bounded, canonical `current` record with an empty `Name` regardless of its
string `Key`; the key is ignored, not treated as a builder/context name, and
is not returned, logged, or passed to a process. `Global` must be boolean, and
either value is accepted for an empty `Name`. A `Name` of `default` still
requires `Key` to equal the reviewed Docker host; every other nonempty name is
rejected.
Canonical original bytes, file-size and actual-read bounds, regular-file/link/owner/mode and Windows ACL checks,
validated home/config ancestry, and local Docker endpoint checks remain
required. The fallback hash is always derived from the reviewed host; its
entry must be absent or exactly `default`, and any `instances/default` entry
rejects. The attestor is read-only and does not repair a profile. Repeated
attestations and command-scoped default-builder pinning remain in force.

**OpenAI permissions and model/TTS boundary.** This local-model selector
change adds no OpenAI OAuth scope, grant, API key, credential copy, OpenAI
recipient, OpenAI model capability, or TTS capability. Local inference uses
the configured Ollama runtime; successful ChatGPT identity sign-in, API
authentication documentation, or Codex's separate local-provider mode does
not establish OpenAI model access or TTS entitlement through Relmio. Requested
and granted scopes for the separate Codex bridge and its applicable provider
permission remain unknown.

**Local-model data handling observed in source.** Relmio reads Docker
context/engine and n8n/network identities, capacity, ownership and resource
metadata, container configuration/security options, hashes, and bounded
acquisition status. Docker inspection parses full container JSON internally,
which can include environment secrets even though attestation uses selected
fields. The builder check reads HOME/USERPROFILE, protected directory/file
metadata, bounded `~/.docker/buildx/current`, the fallback derived from the
reviewed socket, and whether `instances/default` exists; it does not read
`config.json` or nodegroup TLS files. Relmio stores owner-only runtime assets
and metadata beneath its validated home and model cache in its owned Docker
volume; VPS assets are under `/docker/n8n-openai-oauth/local-model`. This
attestation stores no selector data and changes no Docker profile. No OpenAI
token is stored by this model flow. The separate, unchanged OpenAI bridge
stores its copied credential in its managed credential location.

Browser choices and reviewed metadata pass through local Relmio; local Docker
receives inspection/build/start commands and allowlisted helper assets. Docker
registries receive runtime/base-image download requests and Ollama/model
registries receive weight requests. The helper sends model IDs and a fixed
synthetic arithmetic probe to `http://n8n-local-model:11434` without an
Authorization header. Later workflow messages/results travel from n8n to that
private model endpoint on the selected Docker network, not through a browser
reverse proxy. A browser-facing reverse proxy such as ngrok, when used for a
separate n8n/browser route, does not make this model endpoint public. Registries
may observe download traffic; exact registry mirrors/CDN recipients and their
logs are unknown.

Acquisition logs and status use allowlisted fields and bounded output; the
source limits helper/runtime Docker JSON-file logs, and Relmio uses bounded
subprocess output with static failure messages. This is not a no-logging
claim. Actual Ollama, host/SSH/sudo, and n8n execution-history contents,
retention, backups, and downstream disclosures are unknown. Docker host
administrators and trusted network peers remain in the trust boundary.

The earlier same-day source review records historical workflow evidence; it
does not validate this private selector fix or the current manual workflow.
Any prior VPS success remains historical and is not a fresh acceptance result.
Public upstream Buildx source is not proof of equivalence with the installed
Docker Desktop-patched Buildx; that implementation detail remains unverified.
This source review does not establish live installation, model readiness,
workflow success, model quality, provider entitlement, or TTS support.

**OpenAI policy and authentication details.** At re-fetch, the Sign in with
ChatGPT page displayed “Updated: 16 hours ago”; the Codex and API authentication,
models, local-provider, and TTS pages showed no publication date. The Terms of
Use were effective 2026-01-01, the Services Agreement was updated 2025-12-01
and effective 2026-01-01, and the Service Terms were updated 2026-09-21.
Credential/account restrictions and usage limits remain relevant, but these
sources do not determine permission for this bridge or this user's account.
The Chat Adapter's API-key-only connection wording describes that adapter's
configuration contract; it is not an exhaustive statement of OpenAI API
authentication, whose current reference also describes workload-identity
tokens. API-specific data controls do not establish retention for this local
Ollama flow or the separate credential-copy bridge.

**Buildx source limit.** Public
[Buildx v0.36.1 store selection code](https://github.com/docker/buildx/blob/v0.36.1/store/store.go#L193-L246),
[Docker CLI v29.6.2 host/context handling](https://github.com/docker/cli/blob/v29.6.2/cli/command/cli.go#L410-L455),
and [Compose v5.5.1 build selection](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/build_bake.go#L165-L202)
were reviewed for the empty-name selector behavior and the command-scoped
default-builder path. The installed Buildx reports `0.36.1-desktop.1`; its
Desktop patch source is not publicly available in the checked upstream
repository. Public upstream behavior therefore does not prove equivalence of
the installed binary. The separate SSH `BUILDER_STATE_PROBE` policy is
unchanged; this compatibility note applies to the local attestor only.

The local model endpoint's private n8n-to-Ollama network path is distinct from
an optional browser-facing reverse-proxy route such as ngrok. This fix neither
adds an endpoint route nor changes what a reverse proxy exposes.
Registry/CDN recipients and logs, host and n8n log contents/retention, backups,
the bridge's OAuth scopes, account-specific permission, and provider-side
retention remain unknown.

## 2026-09-28 private-candidate OpenAI source check

**Historical source check:** this review records a pre-SIWC candidate and its
prior credential-copy route. Its implementation details are not current.
Consult [the 2026-10-05 source check](openai-source-check-2026-10-05.md) for
the local SIWC implementation and current open questions.

Current official OpenAI sources were fetched again, starting with [Sign in
with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
(displayed “Updated: yesterday”). The [Codex authentication](https://learn.chatgpt.com/docs/auth),
[model availability](https://learn.chatgpt.com/docs/models),
[API authentication](https://developers.openai.com/api/reference/overview#authentication),
[local-provider](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers),
[TTS](https://developers.openai.com/api/docs/guides/text-to-speech), and
[API data-control](https://developers.openai.com/api/docs/guides/your-data)
pages showed no page date. [Terms of Use](https://openai.com/policies/terms-of-use/)
were effective 2026-01-01; [Europe Terms](https://openai.com/policies/eu-terms-of-use/)
were updated 2026-01-16; the [Services Agreement](https://openai.com/policies/services-agreement/)
was updated 2025-12-01 and effective 2026-01-01; [Service Terms](https://openai.com/policies/service-terms/)
were updated 2026-09-21; [Usage Policies](https://openai.com/policies/usage-policies/)
were effective 2025-10-29. The [Privacy Policy](https://openai.com/policies/privacy-policy/)
and [Europe Privacy Policy](https://openai.com/policies/eu-privacy-policy/)
were updated 2026-07-30 and 2026-08-24.

This version-only candidate preparation and the two Docker attestation fixes
add no OpenAI authentication flow, scope, credential-copy path, recipient, model
capability, or TTS capability. The existing bridge still copies the complete
Codex credential after deployment confirmation; it is not identity-only partner
sign-in. Requested and granted scopes and permission for this third-party
transport remain unknown. Codex cache-copy documentation and successful login
are not blanket authorization. The third-party runtime may refresh and rewrite
its credential copy and make separate catalog/npm lookups during a request;
`store:false` does not establish zero retention. The existing reads, storage,
transmission, logging and trust-boundary disclosures above remain applicable.
The local-model path still uses private Ollama with cloud features disabled,
while image/model downloads and separately configured n8n tools can use the
network. Model readiness is not a fresh n8n workflow or general-quality proof.
This review made no sign-in, credential access, model/API request, SSH/Docker
operation, file change, build or test. Existing workflow evidence remains
historical; current candidate, full-stack and bridge inference acceptance were
not established. OpenAI permission and account-specific retention remain open.
