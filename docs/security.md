# Security and limits

The VPS/n8n route handles SSH authentication plus either a ChatGPT OAuth
credential or a separate SuperGrok OAuth session. Local endpoints use
provider-owned OAuth sessions and generated local capabilities. SuperGrok does
not require or read ChatGPT credentials. Treat all of them like passwords.
Read this page before you offer the wizard to another person.

## ChatGPT/Codex sign-in lifetime

OpenAI's Codex authentication guide describes automatic credential refresh but
does not publish a fixed lifetime. The private bridge and hosted chat demo each
refresh their own credential copies. The one-hour access-token and rotating
30-day refresh-token lifetimes documented for the separate Sign in with ChatGPT
plan-usage flow do not establish lifetimes for Relmio's pinned Codex flow.
Relmio's local capabilities remain valid until you rotate them.

## Hosted chat demo

The demo at [relmio.jpfusin.tech/chat](https://relmio.jpfusin.tech/chat) uses
the third-party `openai-oauth` Codex sign-in flow. It is not OpenAI's documented
Sign in with ChatGPT integration. The flow is unofficial and policy-uncertain.

The browser keeps an encrypted session in IndexedDB, where the site's own code
can read it. Each message sends the prompt and access token to Relmio's server
on Vercel, which forwards them to OpenAI. ID and refresh tokens stay in the
browser and are sent only to OpenAI.

Relmio's chat route code does not log prompts or tokens. Hosting-platform and
provider logs and retention are unknown. Signing out removes the browser
session only; it does not revoke access at OpenAI.

## Provider authentication boundaries

Relmio's Codex targets use the [official Codex App
Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints).
Codex owns the ChatGPT OAuth flow, persists its tokens in the target's private
credential store, and refreshes them. Each target has one active ChatGPT account.
Switching requires an explicit sign-out followed by a new sign-in;
OpenAI currently limits its [two-account
switcher](https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching)
to ChatGPT web and says Codex desktop does not yet support it. Relmio does not
pool accounts or choose another account in response to usage.

The experimental SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Local apps use `/v1/chat/completions` with a freshly discovered model and a
separate Relmio client bearer. `grok-build` remains a legacy routing alias. n8n
executes its own tools and returns matching results. The legacy simple `/chat`
request shape remains available through the direct transport. Browser bundles
must not hold the local bearer or call it directly.

Provider credentials stay inside the fresh runtime. Client-owned tools execute
in the client or n8n, never inside the credential-holding HTTP gateway. The
runtime validates private-file ownership, permissions, issuer, session mode,
expiry and installation marker before using the token. It returns neither
provider credentials nor raw authentication errors. Runtime health, provider
readiness, and client-specific live acceptance remain separate checks.

A provider response of 401, 403, or 429 fails on the selected
credential. Relmio never changes accounts automatically after an
authentication, authorization, rate-limit, or quota failure. For example,
[xAI documents backoff for `429`](https://docs.x.ai/developers/rate-limits#handling-rate-limit-errors),
not account or key switching. Any xAI API integration is also subject to the
[xAI Enterprise Terms](https://x.ai/legal/terms-of-service-enterprise).
OpenAI's terms prohibit [circumventing rate limits or
restrictions](https://openai.com/policies/terms-of-use/).
The dashboard never returns or re-shows a stored secret. It reports only
redacted metadata and offers explicit provider-approved recovery actions.

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
- the pinned `openai-oauth` and `ssh2` dependencies are acceptable for
  personal experimental use.

If any of those assumptions is false, do not use this design.

For a local Docker endpoint, the design also assumes:

- the local computer, operating-system account, and Docker Engine are trusted;
- the app receiving the Relmio capability displayed once by the wizard is
  trusted and controlled
  by the same person;
- a browser origin allowlist is not being used as a substitute for secret
  storage; and
- a raw Codex client is trusted with App Server's broad agent and account
  surface, while the Chat Adapter bearer is held only by a trusted local
  backend or development server.

The raw Codex App Server is not a multi-user boundary. It is for a trusted
native client owned by the same account holder, not a browser, shared service,
public app, or untrusted plugin.

The Codex Chat Adapter is a separate, narrower contract. It is for a trusted
local backend or development server owned by the same account holder. Browser
JavaScript must not call it directly, and it is not for a remote, hosted,
shared, or production service.

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
  trust first; the server binds that trust to the exact normalized host and port.
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
- ChatGPT login is written first to a unique pending file, validated, and then
  stored at `~/.n8n-openai-oauth/auth.json` with owner-only permissions. On
  Windows, Relmio applies and reads back the current-account-only NTFS DACL on
  the directory plus every pending, staged, and final credential file. The Codex
  app credential at `~/.codex/auth.json` is not reused or overwritten.
- On verified direct-root VPS sessions, OAuth JSON is validated and transferred
  through SFTP, never interpolated into a shell command.
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
  raw remote command output is not included.
- Docker names are allowlisted before they can enter a command.
- Generated mutation commands come from a closed static allowlist.
- The sidecar runs as user `node`, drops all Linux capabilities, uses
  `no-new-privileges`, and has a read-only root filesystem.
- There is no host `ports` mapping and no reverse-proxy route.
- The installer verifies the absence of a published port after startup.

### Local endpoint controls

- The local browser wizard's `n8n-openai-oauth` option is a Docker-network-only
  sidecar, not a loopback endpoint. Before it writes, Relmio checks the exact
  n8n container, existing network, local Docker socket, and OAuth credential
  again.
- The local n8n sidecar publishes no host port and has no reverse-proxy labels.
  Relmio attaches only the new sidecar to the selected existing network and
  never edits, executes inside, rebuilds, restarts, stops, recreates, or changes
  network membership on n8n.
- The local n8n bridge is create/remove-only for installation and refuses an
  in-place reinstall. Its separately confirmed credential refresh re-attests
  the marker, n8n identity, network, owned
  service, and credential volume. On Docker's reviewed Linux engine it freezes
  only the exact owned sidecar ID, records a validated quiesce snapshot, proves
  that writer stopped, promotes a separate rollback snapshot, then reseeds and
  recreates only that owned sidecar. It never falls back to a graceful stop
  when the freezer is unavailable. Ambiguous quiesce/rollback state is kept for
  inspection; a failed verification never touches n8n or reads a credential
  back from Docker.
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
- Validated OAuth JSON is copied server-side over stdin into a private labeled
  volume by a network-disabled, logging-disabled helper. The source credential
  file is preserved and neither its path nor contents are returned to the
  browser, written into Compose/environment values, or included in errors.
- Generated Compose files publish only literal
  `127.0.0.1:<selected-port>:<container-port>` mappings.
- Every raw Codex WebSocket upgrade and every Codex Chat Adapter route except
  `GET /health` requires a random local Relmio capability. Grok chat also
  requires a local bearer. The wizard displays the capability once and
  persists only its SHA-256 verifier. It remains valid until rotation.
- Relmio accepts no upstream API-key setup or API-key profile operations.
  Retired API installations and saved data remain untouched.

- Raw Codex and Chat Adapter targets use the official Codex App Server inside
  their isolated runtime. The separate n8n OpenAI OAuth bridge starts the
  official Codex CLI browser login on the host and, after the user's explicit
  confirmation, copies the complete `auth.json` into the user's private,
  managed sidecar volume or uploads it to the selected VPS. The credential is
  not returned to the browser. This confirmation authorizes the user's
  deployment operation; it is not an OpenAI delegated grant or proof that the
  account Terms permit this compatibility transport. Relmio does not inspect
  requested or granted OAuth scopes, and their actual values and applicable
  provider permission remain unknown.


- The Chat Adapter rejects every request carrying an `Origin` header, emits no
  CORS permission, and exposes only its authenticated Relmio-specific
  `POST /chat` contract plus readiness and credential-verification probes.
- Each Codex target receives its own private named credential and workspace
  volumes. No long-running local endpoint service mounts a host directory,
  Docker socket, SSH key, browser profile, or host home directory.
- Chat Adapter turns use a named read-only permission profile with network
  disabled. Its model-visible filesystem policy denies root by default, allows
  only Codex's minimal runtime paths and the empty private workspace, and
  explicitly denies the persisted Codex credential store.
- Local managed paths use mode `0700` and generated files use owner-only modes
  on POSIX. Native Windows creates a protected, inheritable NTFS DACL limited
  to the current account and verifies the exact DACL before writing managed
  credentials. Symlinks are rejected and existing unmanaged directories are
  not overwritten.
- The selected Docker context must resolve to a local Unix socket, or to Docker
  Desktop's exact Linux-engine named pipe while `desktop-linux` is selected on
  Windows. Every mutating command is pinned to that local endpoint and Docker
  selector environment overrides are removed.
- Each install uses a random Compose project identity. Containers, networks,
  and volumes must carry matching Relmio ownership labels before update,
  restart, recovery, or sign-in actions are allowed.
- Local n8n stack install/removal locks include the process creation identity
  so PID reuse cannot impersonate the owner. Stale recovery first publishes an
  exclusive nested claim and revalidates the unchanged lock before detaching
  it; ambiguous liveness and changed ownership always fail closed.
- All three long-running loopback endpoint containers run as a non-root user, drop Linux
  capabilities, set `no-new-privileges`, use a read-only root filesystem, and
  have bounded temporary storage and resource limits.
- The one-shot OpenAI credential seed helper is the narrow exception: it has no
  network, port, or logs; runs with a read-only root filesystem and strict
  resource limits; and uses root plus only `CHOWN` long enough to atomically
  make the stdin-seeded volume entry readable by the non-root gateway.

### Local model companion

The provider-free local-model service is separate from the OAuth bridge and n8n
AI Assistant sandbox. Its OpenAI-compatible API has no authentication: any
container on the selected Docker network can make model and management requests.
Treat that network and its containers as trusted. The service has no published
host port or reverse-proxy route.

The managed model network must be an eligible existing user-defined local
bridge, with container communication and Docker DNS, and cannot be `internal`
because acquisition needs egress. For active IP families the default/NAT and
`routed` gateway modes can retain filtering of unpublished ports; `nat-unprotected`,
unknown and isolated modes are rejected. Direct routing is not universally
forbidden: the absence of published ports and the declared supported filtering
configuration are the checked boundary. This is not an audit of every host
firewall rule, nor isolation from the host/root administrator or trusted peers.

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

The copied `auth.json` lets the sidecar act through your ChatGPT account. A
root compromise of the VPS, Docker socket access, or a compromised sidecar can
expose it.

- Never commit `auth.json`.
- Never paste it into issues, logs, screenshots, or chat.
- Do not share one account across customers or users.
- Do not expose the bridge on a domain or public IP.
- Revoke or refresh the session if the VPS may be compromised.
- Prefer a dedicated personal VPS with current security updates.

The local capabilities have separate consequences:



- The raw Codex App Server capability can invoke broad App Server methods
  inside its isolated container and use its signed-in ChatGPT/Codex session.
- The separate Chat Adapter bearer can submit chat turns and resume its bounded
  conversation threads through the signed-in Codex container. Its narrower
  HTTP surface and model permission profile reduce access, but do not make the
  bearer safe to expose or share.
- The Chat Adapter and Grok adapter reject browser origins entirely; keep the bearer
  in a trusted local backend or development server.
- Do not expose any local endpoint on a LAN, public IP, domain, reverse proxy, or
  hosted service. Loopback binding and the bearer capability are both required.
- If a capability is disclosed, update the endpoint to rotate it. If an
  upstream credential may be exposed, revoke or sign out through the provider
  as well.

## Product and policy limitations

- This is not an OpenAI Platform API key.
- A ChatGPT subscription does not normally include OpenAI API credits;
  [OpenAI documents the billing separation here](https://help.openai.com/en/articles/8156019-i-want-to-move-my-chatgpt-subscription-to-the-api).
- The bridge is unofficial and can stop working when upstream behavior changes.
- Models depend on the ChatGPT plan and can change without a project release.
- The bridge's Responses endpoint is stateless and expects full conversation
  history from the caller.
- Rate limits and account restrictions still apply.
- OpenAI can change or discontinue service behavior and can suspend access for
  Terms or usage-policy violations.


- The raw local Codex option preserves the official App Server JSON-RPC protocol.
  It does not provide `/v1/chat/completions`, `/v1/responses`, or any other
  OpenAI API compatibility route.
- OpenAI documents App Server WebSocket transport as experimental and
  unsupported for production. It rejects browser-origin requests and is
  limited here to trusted native same-owner clients.
- The Codex Chat Adapter uses the official App Server lifecycle internally but
  exposes only Relmio's experimental `POST /chat` contract. It is not
  `/v1/chat/completions`, `/v1/responses`, or an OpenAI SDK replacement; it
  rejects browser origins and is limited to trusted local backends or
  development servers.
- Acceptance into Codex for Open Source is not treated by Relmio as permission
  to repurpose credentials, share an account, bypass controls, or broaden the
  scope of another agreement. Review the current
  [program terms](https://learn.chatgpt.com/docs/codex-for-oss-terms).

### Policy evidence and scope

The following sources support the narrow provider and authentication patterns
that Relmio documents. They are not a blanket approval of Relmio, a substitute
for the current agreements governing an account, or legal advice.

| Evidence | What it supports | What it does not establish |
| --- | --- | --- |
| Maintainer acceptance (private OpenAI email, August 2026) and the [Codex for Open Source Program Terms](https://learn.chatgpt.com/docs/codex-for-oss-terms) | Relmio's maintainer was accepted into the program for this project and received a limited-duration ChatGPT Pro benefit covering Codex access. The program is designed to support maintainers of important open-source software. | Program acceptance supports the maintainer and open-source work. It is not an OpenAI security review, product endorsement, or protocol-by-protocol compliance certification. The acceptance email is not published because it contains personal account information. |
| OpenAI's [Advanced Configuration, OSS mode and local providers](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers) | Codex supports custom model-provider configuration and an OSS mode with local providers such as Ollama or LM Studio. | It does not authorize turning a ChatGPT subscription credential into a general API credential or bypassing provider restrictions. |
| [Thibault “Tibo” Sottiaux](https://openai.com/index/openai-to-acquire-astral/), Codex Lead at OpenAI: [open-model statement](https://x.com/thsottiaux/status/2067399435009622521) | The Codex App, CLI, and SDK can run with open-source models rather than only OpenAI models. | Model-provider flexibility does not change authentication, billing, account, or usage-policy requirements. |
| Tibo: [account-use statement](https://x.com/thsottiaux/status/2090675027670978569) | This public statement is not an agreement or a source-check finding for Relmio. | It does not establish permission for this bridge, cross-user sharing, resale, pooling, or subscription-to-API conversion. A social post is not a contractual amendment. |
| OpenAI CEO Sam Altman: [OpenClaw statement](https://x.com/sama/status/2050357911915028689) | OpenClaw was publicly announced as supporting ChatGPT-account sign-in and subscription use. | Approval of one named integration does not automatically approve unrelated protocols, adapters, deployments, or credential handling. |

Relmio applies these distinctions as engineering controls:

- Native Codex uses the official Codex App Server lifecycle and preserves its
  protocol instead of exporting a generic OpenAI `/v1` service.
- The bounded Codex Chat Adapter remains an experimental Relmio-specific
  interface for the same owner; it is not an OpenAI API replacement.
- The n8n AI Assistant model route uses a user-owned OpenAI Platform project
  and API key entered directly in n8n. Relmio never receives that key.
- The legacy n8n OAuth sidecar remains explicitly
  experimental/private/policy-uncertain and is not described as approved by
  the sources above.
- Relmio prohibits account sharing across users, pooling, resale,
  subscription-to-API conversion, rate-limit or safeguard bypass, and
  credential forwarding beyond the explicitly confirmed same-owner bridge
  copy described above. That implementation does not establish provider
  permission for the bridge.

This repository does not claim that every possible use of the bridge is
permitted. The account owner is responsible for reviewing the current
[OpenAI Terms](https://openai.com/policies/terms-of-use/) and usage policies.
The local endpoint design follows the documented
[OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication),
[Codex authentication](https://learn.chatgpt.com/docs/auth), and
[Codex App Server](https://learn.chatgpt.com/docs/app-server) boundaries. This
is engineering guidance, not legal advice or an OpenAI approval.

## Dependency policy

The current release pins:

- Node.js 24+
- `ssh2` `1.17.0`
- `openai-oauth` `2.0.0`
- `@openai/codex` `0.147.0` in the local Codex image

The POSIX and native Windows PowerShell bootstraps reuse a compatible local
Node.js runtime or download the matching current official Node.js 24 archive
to a private temporary directory. Each validates the archive against Node.js's
SHA-256 manifest before execution and removes it when the wizard closes. The
PowerShell bootstrap accepts only strict Windows x64 or ARM64 archive names,
uses HTTPS without redirects, and enables TLS 1.2 for Windows PowerShell 5.1.
npm lifecycle scripts are disabled when either bootstrap starts Relmio. The
generated sidecar also installs `openai-oauth` with `--ignore-scripts`.

Do not replace pinned versions with `latest` in production. Follow the upgrade
checklist in [maintenance.md](maintenance.md).

## Reporting a security problem

Do not open a public issue containing a token, password, private IP, hostname,
workflow data, or unredacted log. Revoke exposed credentials first, then share
only a sanitized reproduction with the repository owner.

## 2026-09-26 OpenAI source check

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
entitlement or successful completion. Flare/Sunburst model IDs are discovery
entries, not proof of access. Audio/TTS, transcription, translation, Live and
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
| Other network recipients | Building the sidecar installs the pinned package via npm/Node/package-image infrastructure. Model discovery also requests `registry.npmjs.org/@openai/codex/latest`; reviewed code adds no OpenAI bearer to that lookup. These are separate from model inference. |
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
