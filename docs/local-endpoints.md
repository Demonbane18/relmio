# Local Docker endpoints

Relmio connects local apps and private n8n companions to ChatGPT plan use,
Codex clients, SuperGrok, and provider-free local models. ChatGPT SIWC
registrations are kept separate from personal Codex credentials and from
SuperGrok sessions.

| Wizard option | Local interface | Upstream sign-in | Intended client |
|---|---|---|---|
| **Codex App Server** | Local WebSocket relay to official App Server over stdio | Selected SIWC registration and short-lived Responses access token | A trusted native client owned by the same person |
| **Codex Chat Adapter** | Relmio-specific HTTP `POST /chat` | Selected SIWC registration and short-lived Responses access token | A trusted local backend; read-only conversational turn |
| **Grok on this computer** | Loopback `/v1/chat/completions` and simple `POST /chat` | Fresh OAuth/device sign-in through the official Grok CLI | A trusted local backend or development server owned by the same person |
| **ChatGPT for n8n** | Private `http://n8n-openai-oauth:10531/v1` on one selected Docker network | One-time local Relmio bearer; provider token stays in the sidecar | The selected self-hosted n8n deployment |
| **Grok for n8n** | Private `http://n8n-supergrok:14502/v1` on one existing Docker network | Separate fresh Grok OAuth session and one-time local bearer | Only the selected local or VPS n8n deployment |
| **n8n AI Assistant tools** | Private Code Sandbox plus optional SearXNG JSON search on one existing Docker network | A generated sandbox key shown once; model-provider credentials stay in n8n | Only the selected self-hosted n8n deployment |
| **Local model for n8n** | Private `http://n8n-local-model:11434/v1` on one existing Docker network | No provider sign-in; Ollama API key is ignored | Only the selected self-hosted n8n deployment |
| **Set up new n8n** | A new owned n8n stack with loopback access and a Basic-Auth-protected public ngrok route | n8n credentials stay in its owned data volume; ngrok uses an operator-supplied token | A new disposable local n8n installation and its webhooks |

The local SIWC flow keeps identity, ChatGPT plan permission, and model access
separate. The gateway uses the public OpenAI Responses API under the selected
registration's grant. It is not an OpenAI Platform API key or a general-purpose
account API. The direct Codex WebSocket target is high trust; the separate
Chat Adapter is a read-only conversational contract. Neither is a hosted or
public service.

These are code-supported limits, not additional commercial or partner
requirements: local open-source SIWC uses the documented dynamic registration
flow without a partner client ID or secret. Users still grant ChatGPT plan use
separately, and applicable OpenAI Terms continue to apply. The distinct VPS
token-storage question is covered below.

## ChatGPT SIWC registration lifetime

The SIWC access token is refreshed by Relmio for the selected registration.
OpenAI's documented access-token and refresh-token lifetimes apply to SIWC, not
to a personal Codex credential. The local client bearer is a separate
installation credential and does not grant provider access by itself.

## ChatGPT registration and plan use

Relmio creates a separate SIWC registration through OpenAI's documented
dynamic-client flow and persists the issued client ID, verified issuer and
subject, granted scopes, host owner, and session tokens in protected storage.
Email is a display label, not an account key. Distinct registrations remain
separate when their email addresses match.

Verified identity may connect without `chatgpt.tokens.use.direct`; that
identity-only account cannot use ChatGPT plan models until the user completes
the separate plan-consent flow. Relmio cannot enable this grant with a local
checkbox. The local account selector, plan toggle, first-use confirmation, and
sign-out apply to the selected registration only.

The documented SIWC access/refresh token lifetimes are not a fixed lifetime
claim for personal Codex credentials. Relmio refreshes the selected SIWC
registration. Provider errors do not select another account or fall back to
separately billed API access.

The experimental SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Local apps use `/v1/chat/completions` with model `grok-build` and a separate
Relmio client bearer. n8n executes its own tools and returns matching results.
The legacy simple `/chat` request shape remains available through the direct
transport. Browser bundles must not hold the local bearer or call it directly.

The default URL is `http://127.0.0.1:14502`. Use the `/v1` base URL with a
Chat Completions client. n8n's custom-model API-key field holds the local
Relmio bearer, never an xAI API key or the provider's OAuth token. A private
Docker connection uses the `grok-build` service on its owned network. Existing
n8n environment changes and restarts remain outside this setup.

The session volume must be empty at first initialization or already carry
this installation's matching fresh-session marker. An older unmarked Grok
store is refused rather than imported. Authentication or quota failures never
select a different account or fall back to API-key billing.

See the [direct OAuth route](supergrok-oauth-route-decision.md) and
[n8n acceptance contract](local-n8n-xai-spec.md).

## Requirements

- Native Windows with Docker Desktop's `desktop-linux` engine, macOS, Linux,
  or Linux under WSL2. Relmio verifies owner-only managed-file permissions
  before writing.
- Docker Engine or Docker Desktop with Docker Compose v2 on the local computer.
- A free loopback port for a local endpoint: `14500` for native Codex, `14501`
  for Codex Chat Adapter, or `14502` for the Grok Build adapter.
- For a private n8n companion, a running official n8n container and existing
  shared Docker network.
- For the local-model companion, enough measured Docker-engine memory, CPU and
  available disk for one allowlisted model. See [Private local models](local-models.md)
  for capacity details and the download/resource review.
- For the VPS model route, an SSH-reachable Linux host with rootful Docker
  Engine, Compose v2 and Buildx targeting that same local daemon, plus a safe
  preexisting root-owned `/docker`. Choose the
  actual SSH username and **Local SSH agent** or approved password. Verified
  **Passwordless sudo -n (model only)** is limited to model management, not
  OAuth bridges, Assistant or SuperGrok. Do not upload keys, enable root/password
  SSH or weaken existing policy. See [Hosting compatibility](hosting-compatibility.md)
  for provider/image guidance and Render's separate manual private-service path.
- For AI Assistant tools, enough capacity for the privileged Docker-in-Docker
  runner. For a new local n8n stack, an ngrok authtoken and reserved hostname,
  strong Basic Auth credentials, and two free loopback ports.
- A user-authorized ChatGPT registration with the separately granted
  `chatgpt.tokens.use.direct` permission for model use; an identity-only
  registration remains connected but cannot make plan requests. The public
  API/model path still depends on account eligibility and provider admission.
- For loopback endpoints, a trusted local app that can keep the Relmio
  capability secret.

The local path does not need a VPS or SSH access and does not modify an
existing n8n deployment. It creates a separate Relmio-managed Docker Compose
project on the local computer.

## Install with the browser wizard

1. Start Relmio on the computer that will run the endpoint. Use one of the
   commands on the [hosted install page](https://relmio.jpfusin.tech/install),
   or run:

   ```bash
   npx --yes --ignore-scripts relmio@latest
   ```

2. Relmio opens the local dashboard through an owner-only, single-use browser
   handoff. If it does not open, press Enter in the active foreground terminal
   or run `relmio open` from a persistent install. Then select **Add connection**.
3. Choose **ChatGPT for n8n**, **Grok for n8n**, **Local model for n8n**,
   **Set up new n8n**, or **Grok on this computer**. Open **More connections
   and tools** for Codex endpoints and **n8n AI Assistant tools**.
4. For ChatGPT, select or create a registration, complete the system-browser
   sign-in, and separately allow plan use in ChatGPT. Confirm the first-use
   plan notice before model requests. For an n8n companion, select its running
   container and network, then separately approve background workflow use.
   Local-model setup selects its n8n container/network and allowlisted model;
   Assistant tools include Code Sandbox and optional SearXNG, off by default.
5. Review the selected account, target, private-network boundary, and exact
   write plan. On VPS, verify the SSH fingerprint before authentication and
   confirm the final remote write after review.
6. For a local Codex endpoint, copy its one-time Relmio bearer from the result
   screen. The App Server bearer is high trust; the Chat Adapter bearer is for
   the narrower read-only route. Do not put either in browser code.

## Persistent local dashboard

The standard `relmio` command opens a dashboard before the setup flow. Its
inventory covers three loopback OAuth endpoints and five n8n/support services,
including the managed local-model runtime. It reads fixed managed directories,
the selected local Docker context, and exact Docker resource identities; it
does not discover or manage retired API-key targets.

The dashboard does not keep a second registry or adopt containers from labels
alone.

An installed Relmio package provides a small dashboard lifecycle:

```text
relmio start
relmio status
relmio open
relmio stop
```

These commands manage only the current operating-system account's Relmio
dashboard on `127.0.0.1`. `relmio stop` stops only the Relmio dashboard
process. It does not stop, restart, rebuild, or reconfigure n8n, ngrok, any
Relmio-managed companion, or any installed endpoint.

**Refresh status** is read-only. Safe connection URLs can be copied after
attestation, but stored secrets cannot. Selecting **Add connection** opens the
same reviewed four-step wizard, and every write still requires its own current
ownership checks and confirmation.

See [Use the local dashboard](./local-dashboard.md) for launch and reopen
commands, the complete service and action matrix, state meanings, one-time
credential rules, and n8n ownership boundaries.

Relmio will not overwrite an unmanaged directory or follow a symlink. Its
local files live under:

```text
~/.relmio/local/xai-grok-build
~/.relmio/local/codex-chatgpt
~/.relmio/local/codex-chat
~/.relmio/local/n8n-openai-oauth
~/.relmio/local/n8n-ai-assistant
~/.relmio/local/n8n-stack
~/.relmio/local/n8n-local-model
```

Advanced or test environments can set `RELMIO_HOME` before starting the
wizard to an absolute managed base whose final component is `.relmio`.

Each target directory contains `.managed-by-relmio.json`. Endpoint markers
record the target, port, Docker socket URI, installation ID, and unique Compose
project name. The n8n bridge marker instead records the exact selected n8n
container and network identities. The Assistant marker records generated
service identities and the SearXNG selection; the local-model marker records
its selected model and measured resource plan. No marker contains a provider
credential. Relmio uses those identities to distinguish its resources from
another checkout or user's resources on the same Docker Engine.

## Self-hosted n8n bridge

The OpenAI-compatible n8n sidecar uses the selected SIWC registration and
requires an existing n8n container and shared Docker network. The wizard
re-attests the selected container, network, and Docker host before writing. Its
sidecar joins only that network; there is no host-port or reverse-proxy
mapping, and Relmio does not edit n8n's Compose file, credentials, container,
image, or lifecycle.

Before install, enable ChatGPT plan use and confirm the first-use notice.
Separately approve the n8n background-workflow use and the reviewed install
plan. The installer generates an installation-local bearer, displays it once,
and stores only its hash in Compose. Enter that bearer manually as n8n's API
key:

```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: <one-time Relmio bearer shown by the wizard>
Use Responses API: On
```

The n8n bearer authorizes the local sidecar; it is not an OpenAI credential.
The provider access token stays in the sidecar's protected SIWC registration.
Requests use `GET /v1/models` and `POST /v1/responses`. For the n8n sidecar,
the catalog `client_version` follows the newest stable Codex release from npm,
checked about every 12 hours and never below Relmio's pin (0.160.0). The registry
sees the server's IP address but receives no credentials. The sidecar caches
the catalog for 5 minutes. OpenAI does not document this version filter.
Local Codex clients and the pre-install account picker still use the pin.
Local n8n sidecars have no model-check controls and default to checks off; they
still learn from completed requests and hide model-level failures for a day.
See [model discovery and checks](n8n-configuration.md#model-discovery-and-checks).

The sidecar also has a
Chat Completions compatibility path that accepts text messages and function
tools. Function tools go upstream in one `additional_tools` item, and n8n runs
the tools itself. Limits are 32 tool calls, 128 KiB of arguments per call, and
2 MiB of streamed arguments in total. It rejects a named `tool_choice`, tool
namespaces, custom tools in streamed requests, system messages, and
unsupported request fields. Chat clients receive only final-answer text;
reasoning items and intermediate commentary are not passed on. On 2026-10-05
a two-turn LangChain tool test passed through the real gateway on one ChatGPT
account, streaming over both routes. There is no account rotation or Platform
API fallback. Audio, video, Files API management, stored
responses/conversations, and moderation are unsupported. Image generation is
an opt-in add-on for a VPS sidecar only; a local sidecar has no image sign-in,
so its image routes return `images_off`. See
[VPS and n8n](vps-and-n8n.md#turn-on-image-generation-optional).

Legacy installations are not silently adopted or overwritten. The wizard
requires fresh SIWC sign-in and a separately reviewed migration. A successful
install check or model listing does not prove model entitlement, host
admission, or a completed inference.

For VPS setup, fingerprint verification occurs before authentication and a
separate final confirmation is required before remote writes. Relmio creates
and preserves a distinct host ID for the destination, freezes the source
registration before transfer, and clears sender tokens only after an attested
destination receipt. An uncertain transfer stays frozen until inspected. The
reviewed n8n container and network IDs are checked again before the first
write and before the transfer. After the install completes, status and
sign-out need only the same SSH host identity and network ID, so they keep
working if n8n is recreated or the SSH login method changes. If an install
stops partway, status shows it as staged and the wizard offers a reviewed
resume for the selected account. A lost acceptance acknowledgment is
reconciled from the destination's receipt; without one, the sender stays
frozen and needs a fresh sign-in. Relmio never restarts an old writer
automatically.
Transferred credentials are refreshed only by the destination installation.
The published VM guide and SIWC Terms do not resolve whether this persistent
remote storage is allowed; Relmio does not claim provider approval for VPS use.

## SuperGrok OAuth for n8n

This experimental connection uses the official Grok runtime's OAuth and a
separate one-time local bearer. No xAI API key is requested, stored, or used as
a fallback. The companion publishes no host port and leaves the selected n8n
untouched. It works locally or through the VPS wizard without ChatGPT sign-in.

## n8n AI Assistant tools

The local Assistant option creates a separate ownership-labeled Compose
project containing the Code Sandbox API, certificate initializer, and a
privileged Docker-in-Docker runner. If explicitly selected, it also creates a
private SearXNG service with JSON responses enabled. SearXNG is off by default.
Only the sandbox API and optional SearXNG service join the exact reviewed n8n
network; none of the companion services publish a host port or reverse-proxy
route.

Relmio discovers the selected n8n container and network read-only, re-attests
them before and after writing its own managed files, and never edits, executes
inside, rebuilds, restarts, stops, recreates, or changes network membership on
n8n. It verifies the owned resource set, exact running services, sandbox
health, zero host publication, and optional SearXNG JSON response before it
reports success.

The result screen returns an exact companion-settings block shaped like this,
using the generated private URL and one-time key from that installation:

```text
N8N_INSTANCE_AI_SANDBOX_ENABLED=true
N8N_INSTANCE_AI_SANDBOX_PROVIDER=n8n-sandbox
N8N_INSTANCE_AI_SANDBOX_IMAGE=<immutable Relmio-reviewed sandbox image>
N8N_SANDBOX_SERVICE_URL=http://relmio-ai-sandbox-<generated-id>:8080
N8N_SANDBOX_SERVICE_API_KEY=<shown once>
N8N_INSTANCE_AI_SEARXNG_URL=http://relmio-ai-searxng-<generated-id>:8080
```

The final SearXNG line is present only when web search was selected. This apply
block deliberately excludes `N8N_ENABLED_MODULES`. Preserve its existing value
and ensure it continues to include `instance-ai`; never replace unknown module
entries with the companion block. Apply only the returned values and restart
n8n through your own deployment workflow;
Relmio does not change or restart n8n. Configure the AI model provider and its
credential directly in n8n.

The privileged runner is intended for local development and testing. Use
n8n's recommended Daytona sandbox path for production. The Ready screen's
separately confirmed **Remove n8n Assistant tools** action removes only the
owned companion project and local managed files; the selected external network
and n8n container remain untouched.

## Safe updates and credential rotation

Installed SIWC account controls are separate from local bearer rotation. Before
sign-out or disabling plan use, Relmio attests the exact owned sidecar and
stops it. If it cannot confirm that the service stopped, it does not mutate the
registration. Provider revocation status is reported separately from clearing
local tokens.

Select the offered local credential rotation action to replace only the
Relmio bearer used by your local app. Relmio attests the exact installation,
stages a new capability, activates its verifier, and checks the authenticated
endpoint before reporting success. The provider's OAuth session remains in
its private volume.

If activation fails, Relmio restores the previous verifier and re-attests
health and loopback publication. It does not retain the old raw capability.
An uncertain rollback fails closed and reports whether the exact owned
service could be stopped.

A full managed update retains the target's private credential and workspace
volumes unless deletion is explicitly confirmed. Do not hand-edit the marker,
Compose file, credential volume, or verifier. Ownership drift stops the update.

## Codex App Server relay

The result screen provides the existing local WebSocket endpoint and its
one-time Relmio capability:

```text
Endpoint: ws://127.0.0.1:14500
Authorization: Bearer <the Relmio capability shown once by the wizard>
Protocol: Codex App Server JSON-RPC
```

The relay forwards JSON-RPC to the official Codex App Server over stdio,
configured to use the selected SIWC access token with the public Responses API.
It does not start Codex's native device-code login or expose provider tokens to
the browser. The raw App Server target is high trust and intended only for a
trusted native client owned by the same account holder.

The generated runtime disables agent spawning, and the relay rejects deferred
tool loading (`tool_search`), hosted connectors/MCP OAuth, account/auth
operations, and marketplace/plugin/configuration mutations. This is not full
App Server, agent, or MCP feature parity. Inline function/custom tools remain
within the high-trust native-client boundary. The relay forwards every client
JSON-RPC call except a short deny-list to the official App Server, which runs
as the same user that owns the SIWC store. Connect only trusted local clients.
After install, Relmio checks the selected account's live model catalog inside
the running container with `docker compose exec`, not in a one-off helper
container.

The RPC gate also rejects per-thread provider/model configuration and
provider fallback overrides, plus path/history/rollout selectors on thread
resume/fork. The App Server child is configured with request and stream
retries set to zero; failures and disconnections are not automatically retried
or replayed.

The access token is not renewed inside an open socket. The relay closes it
shortly before expiry; reconnect to obtain a fresh lease. Successfully started
threads have protected account-bound records and may be explicitly resumed
after a relay restart. Unknown or foreign IDs are rejected; a supplied model
must be listed for the selected registration. An interrupted turn is never
replayed.

A compatible Codex CLI can connect like this. Read the capability without
putting it in the command line:

```bash
read -r -s CODEX_REMOTE_TOKEN
printf '\n'
codex --remote ws://127.0.0.1:14500 \
  --remote-auth-token-env CODEX_REMOTE_TOKEN
unset CODEX_REMOTE_TOKEN
```

This is not an OpenAI `/v1` endpoint. A client must implement the official
App Server initialization and JSON-RPC protocol, including its thread, turn,
approval, and event messages.

### Experimental and high-trust boundary

OpenAI documents the App Server command and WebSocket transport as experimental
and unsupported for production workloads. The raw server rejects requests that
carry a browser `Origin` header, so it is not a direct browser/web-app endpoint.
Use it only with a trusted native client controlled by the same account owner.

Possession of the App Server bearer gives a trusted client the raw Codex
App Server's high-trust JSON-RPC and local-tool surface. Use it only from a
native client controlled by the same account owner. It is not for another
user, a browser, a shared service, a public endpoint, or an untrusted plugin.

The child process receives the selected SIWC access token as `ACCESS_TOKEN`.
A same-UID tool can inspect its own process environment or files. Relmio does
not claim an OS isolation boundary that prevents an authorized client or tool
from exposing its own process data. Keep the bearer local and never expose the
WebSocket on a LAN, domain, reverse proxy, or public IP.

## Codex Chat Adapter: development backends

The adapter result screen provides:

```text
Endpoint: http://127.0.0.1:14501
Authorization: Bearer <the Relmio capability shown once by the wizard>
Protocol: Relmio Codex Chat HTTP
```

The local backend uses the selected SIWC registration. The adapter starts a
read-only conversational turn and binds each conversation ID to that account.
Keep its one-time bearer in the trusted local backend, not in a command line or
browser code.

```bash
read -r -s RELMIO_CODEX_CHAT_KEY
printf '\n'
printf 'Authorization: Bearer %s\n' "$RELMIO_CODEX_CHAT_KEY" |
  curl --fail-with-body --silent --show-error \
    --request POST http://127.0.0.1:14501/chat \
    --header @- \
    --header "Content-Type: application/json" \
    --data '{"input":"Reply with a short hello."}'
unset RELMIO_CODEX_CHAT_KEY
```

The response contains only the App Server thread ID and final conversational
text:

```json
{
  "conversationId": "thread-id-from-the-first-response",
  "output": "Hello!"
}
```

To verify incremental delivery, request Relmio's versioned event stream. The
stream emits `start`, `progress`, zero or more `delta` events, and exactly one
`terminal` event. A completed terminal includes the `conversationId`; a failed
terminal is preceded by a redacted `error` event:

```bash
read -r -s RELMIO_CODEX_CHAT_KEY
printf '\n'
printf 'Authorization: Bearer %s\n' "$RELMIO_CODEX_CHAT_KEY" |
  curl --no-buffer --fail-with-body --silent --show-error \
    --request POST http://127.0.0.1:14501/chat \
    --header @- \
    --header "Accept: text/event-stream" \
    --header "Content-Type: application/json" \
    --data '{"input":"What is a robot? Answer in two short sentences."}'
unset RELMIO_CODEX_CHAT_KEY
```

The adapter maps App Server turn errors into a bounded status, code, and
recovery action. `usageLimitExceeded` maps to the `usage_limit`/Manage usage
path, `unauthorized` to reauthorization, `badRequest` to request correction,
and stream disconnection to an interrupted-turn recovery. It does not invent
a public Responses API envelope or forward the `additionalDetails` field from
the Codex error object.

Send that `conversationId` with the next `input` to continue the same
conversation. The adapter initializes the official App Server, starts or
resumes the thread, runs a read-only conversational turn, and returns the
authoritative final agent message. The model sandbox has no network access and
uses a root-deny filesystem policy that reads only Codex's minimal runtime
paths and the empty private workspace. It explicitly denies
`/home/node/.codex`, the private volume containing the ChatGPT session.

This route is deliberately not `/v1/chat/completions` or `/v1/responses`.
SDKs that require those schemas need a separately configured API endpoint
in the consuming client. The Codex Chat Adapter rejects every request carrying an `Origin`
header and sends no CORS permission, so browser JavaScript must not call it
directly. Keep the bearer in a trusted local backend or development server and
let the browser call that server's own session-aware route.

The adapter is experimental because it depends on the experimental App Server
interface. It is loopback-only, single-owner development tooling, not a hosted,
LAN, multi-user, or production service. It enforces bounded request bodies,
output, concurrency, process lifetime, and sanitized failures, but those
controls do not create a general-purpose API entitlement.

### In-wizard Chat Adapter tester

The Ready screen for an installed Chat Adapter includes a narrow local tester.
It is intended for a literal `http://127.0.0.1:PORT` adapter address only. The
browser never calls the adapter: it calls the local wizard's existing
same-origin, `X-Setup-Token` protected APIs, and the wizard makes the
server-side `POST /chat` request without an `Origin` header.

When the user secures the displayed client credential, the browser clears the
input and encrypts it with the tester's short-lived RSA-OAEP SHA-256 public
key. The private key exists only in local server memory, expires after a few
minutes, has a bounded session count, and can be invalidated with **Forget
tester**. The browser retains only ciphertext and key ID for the test session;
it keeps prompts and transcript only in current-page memory and DOM.

This reduces accidental credential transit and storage exposure. It is not
encryption at rest or end-to-end encryption, and it cannot protect against a
compromised browser, extension, or local machine. The tester rejects redirects,
non-loopback URLs, malformed or oversized data, concurrent key use, and
adapter failures with redacted messages. Assistant text appears incrementally
while the adapter is working. The tester distinguishes connecting, waiting for
the first text, active streaming, completion, interruption, and failure without
announcing every text chunk. **Stop response** aborts the existing secured
wizard relay and keeps partial text visible; reduced-motion mode shows the same
states without animation. The tester reports success only after the completed
terminal event arrives. These presentation states do not change the adapter's
`POST /chat` SSE contract or any external client behavior.

## SuperGrok: development backends

The experimental `xai-grok-build` target defaults to `http://127.0.0.1:14502`.
Use `http://127.0.0.1:14502/v1` in a Chat Completions client. `grok-build` is
a supported legacy routing alias. The runtime's fresh OAuth catalog uses the
official CLI proxy's fixed `GET /v1/models` endpoint; the current live account
listed `grok-4.6` and `grok-4.5`. A listing is not per-model tool proof. It also
accepts the bounded Relmio `POST /chat` contract and streams SSE. Keep its
local bearer in a trusted backend. Browser-origin requests are rejected, and
the Responses API is not supported.

After the local endpoint is installed, run this in an interactive terminal:

```sh
relmio grok login
```

Approve the displayed device code on the official provider page. The login has
a fifteen-minute limit. `relmio grok logout` explicitly signs this runtime out;
it does not affect another application's account. Interrupted login cleanup
fails closed when the container's termination cannot be established.

The pinned official Grok CLI owns sign-in and sign-out in the runtime's fresh
private volume. Complete device login in an interactive terminal; do not copy
tokens into Relmio or configure an xAI API key. The HTTP handler reads only this
runtime's marked session and never consumes refresh tokens. Expiry requires
another explicit official sign-in.

The generated image pins the executable for credential actions. Inference
uses direct HTTP and does not invoke CLI tools. Explicit `grok-4.6` passed an
actual n8n Assistant node-catalog tool and an n8n AI Agent Calculator workflow
with `317 × 29 = 9193`. Live disposable OAuth and n8n tool/result acceptance
passed; fresh private-installer acceptance also passed. Live logout/refusal,
browser, and release gates remain separate. A healthy container alone proves
neither OAuth readiness nor credential isolation.

## Network and container boundary

Each of the three OAuth endpoint projects publishes exactly one loopback
mapping:

```text
127.0.0.1:<selected-port>:<container-port>
```

Long-running endpoints use non-root users, dropped Linux capabilities,
`no-new-privileges`, read-only root filesystems, bounded temporary storage,
and target-specific named volumes. No endpoint mounts a host home directory,
Docker socket, SSH key, or browser profile.

Private n8n companions publish no host mapping. They join only the reviewed
network and leave the selected n8n container and external network unchanged.
The local bearer remains necessary even on loopback; keep it private.

## Retired API installations

**Upgrading does not stop an existing API-key gateway.** Relmio does not
discover or manage legacy `openai-api` or `xai-inference` endpoints. An older
container can continue listening and using its saved credential even though it
has no dashboard row. The upgrade does not migrate or delete its data.

To retire one, review it manually before stopping anything. These instructions
apply only to a legacy Relmio API endpoint, never to n8n or its OAuth bridge.

1. Read the exact legacy target's `.managed-by-relmio.json` locally. Do not
   source or execute it. Require schema version `2`, target `openai-api` or
   `xai-inference`, a 32-character lowercase hexadecimal `installId`, and the
   expected `relmio-<target>-<installId>` project name. Use only a recognized
   local Docker socket. Stop if any identity is uncertain.
2. List containers using all three ownership labels. Replace each placeholder
   with its manually verified literal value:

   ```bash
   docker --host <verified-local-socket> ps -a \
     --filter label=io.relmio.managed=true \
     --filter label=io.relmio.target=<legacy-target> \
     --filter label=io.relmio.install=<installId>
   ```

3. Inspect only the returned literal container ID's labels and published ports.
   Do not print its environment or credential volume contents:

   ```bash
   docker --host <verified-local-socket> container inspect \
     --format '{{json .Config.Labels}}' <literal-container-id>
   docker --host <verified-local-socket> container inspect \
     --format '{{json .HostConfig.PortBindings}}' <literal-container-id>
   ```

4. Confirm the exact target, installation, Compose project, and loopback mapping.
   If they match and you intend to stop that endpoint, stop and remove only that
   container. Do not run these commands for an uncertain or foreign resource:

   ```bash
   docker --host <verified-local-socket> container stop <literal-container-id>
   docker --host <verified-local-socket> container rm <literal-container-id>
   ```

Keep its volumes, managed directory, and marker for recovery. Credential-volume
or network deletion requires a separate explicit decision and exact ownership
review. Never use a wildcard, a global prune, or another project's Compose
file. Relmio does not perform this migration automatically.

## Recovery and uninstall

The manual Docker recovery commands below apply only to the two Codex targets;
verify their exact ownership before use. Use the dashboard's reviewed
ownership/migration actions for Grok and the ChatGPT n8n sidecar, not these
commands.

An older credential-copy sidecar is migrated only through a separate fresh
SIWC sign-in, migration consent, and final confirmation. Relmio stops only the
exact attested old service and keeps its credential/workspace volumes offline.
If any step is uncertain, it does not resume or delete those volumes; inspect
the retained state through the dashboard. Neither path changes the selected
n8n service or its external network.

The commands below are intentionally scoped to one persisted installation.
They are not safe until you verify ownership. First open, but do not execute or
shell-evaluate, the exact target's `.managed-by-relmio.json`. Manually copy its
literal values only after confirming all of these conditions:

- `schemaVersion` is `2` and `target` is the target you intend to operate on;
- `installId` is exactly 32 lowercase hexadecimal characters;
- `projectName` is exactly `relmio-<target>-<installId>`;
- `dockerHost` is a `unix:///absolute/socket/path` that you recognize; and
- the absolute Compose path is inside that same managed target directory, is
  not a symlink, and names `docker-compose.yml`.

In every example, manually replace each angle-bracket placeholder with the
already-validated literal. Do not use `eval`, source the JSON, or construct a
Docker command from unvalidated marker text. The only valid service name is
`codex` for `codex-chatgpt` or `codex-chat`
for `codex-chat`.

### Recover from a failed install

If Relmio reports that it could not confirm cleanup, keep the marker and
managed files in place. List only candidate containers, networks, and volumes
for the recorded installation:

```bash
docker --host <dockerHost> ps -a \
  --filter label=io.relmio.managed=true \
  --filter label=io.relmio.target=<target> \
  --filter label=io.relmio.install=<installId>
docker --host <dockerHost> network ls \
  --filter label=io.relmio.managed=true \
  --filter label=io.relmio.target=<target> \
  --filter label=io.relmio.install=<installId>
docker --host <dockerHost> volume ls \
  --filter label=io.relmio.managed=true \
  --filter label=io.relmio.target=<target> \
  --filter label=io.relmio.install=<installId>
```

Inspect every listed object individually, using its literal name or ID rather
than a wildcard:

```bash
docker --host <dockerHost> container inspect <literal-container-id>
docker --host <dockerHost> network inspect <literal-network-id>
docker --host <dockerHost> volume inspect <literal-volume-name>
```

Confirm all three labels, `io.relmio.managed=true`, the exact target, and the
exact installation ID, match the marker. If any label or identity differs,
stop. Only after they all match may you stop and remove the one managed
service:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  rm --stop --force <codex-or-codex-chat>
```

This recovery command does not target other services, remove the project
network, or delete volumes. After confirming the service is gone, rerun the
wizard and approve a fresh plan.

### Uninstall Codex while retaining its data

After the same marker and label verification, stop the target and remove its
container and project network with:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  down
```

Do not add `--volumes`. The named Codex home and workspace volumes retain the
installed SIWC session data and workspace. Keep the managed target directory
and marker as well; they preserve ownership identity needed for safe reuse or
later removal. Never remove the parent `~/.relmio`, use a wildcard, or remove
the other target.



### Permanently delete the local Codex session and workspace

Back up anything intentionally retained, and confirm you want to erase this
target's local SIWC session data and workspace. If you also want provider
revocation, first use the account's explicit **Sign out** action and review its
result; this Docker command does not request or verify remote revocation.
Repeat the marker and label checks before running this project-scoped command:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  down --volumes
```

`--volumes` irreversibly deletes this target's managed session and workspace
volumes. Local deletion is not proof that OpenAI revoked access or deleted
provider-side data. After Docker confirms the matching resources are gone, you
may remove only the exact `~/.relmio/local/codex-chatgpt` or
`~/.relmio/local/codex-chat` managed directory for the target verified through
your file manager.

## Troubleshooting

- **Docker unavailable:** start Docker Desktop or the Docker daemon and verify
  `docker version` and `docker compose version` locally.
- **Port already in use:** choose another unprivileged port in the wizard and
  review the updated endpoint before confirming.
- **`401` from the local adapter:** use the Relmio bearer shown once at setup.
  That bearer protects the local connection; it is not a provider API key.

- **A ChatGPT plan account is connected but cannot use models:** check the
  selected registration's plan-permission state. Identity sign-in alone does
  not grant `chatgpt.tokens.use.direct`; choose **Allow ChatGPT plan use** and
  complete the separate provider consent. If the account is signed out or
  needs reauthorization, start a fresh sign-in for that registration.
- **A plan request reaches a usage limit:** open **Manage usage** in ChatGPT.
  Relmio does not switch accounts, retry through another provider, or reset
  usage by signing in again.
- **Sign-out says revocation was not confirmed:** local tokens were cleared,
  but remote revocation was uncertain. Disconnect Relmio in ChatGPT settings;
  local cleanup alone does not prove provider revocation.
- **Native Windows security check failed:** select Docker Desktop's
  `desktop-linux` context and retry. Relmio must be able to create and read back
  a protected current-account-only NTFS DACL; it makes no Docker change when
  that check fails. WSL2 remains a supported fallback.

## Official sources and account terms

The current local ChatGPT plan path is described in the
[2026-10-05 source check](openai-source-check-2026-10-05.md), which links
OpenAI's SIWC guides, plan-use help, terms, and privacy sources and separates
documented local behavior from unresolved hosted/VM requirements. SIWC plan
use is distinct from a Platform API key or a Codex device-code login. The
source review does not claim that Codex for Open Source membership grants
unrelated API, hosting, or token-storage permission.

Relmio never changes accounts automatically. Model requests use the selected
registration; choose another registration explicitly. Reauthorization is for
that registration and does not merge accounts by email.

## Private SuperGrok companion for existing n8n

The experimental **Grok for n8n** connection installs a separate owned
companion on one selected n8n Docker network. It publishes no host port and
keeps its fresh official login in its own volume. The plan does not read or
import a ChatGPT session.

An earlier development SuperGrok installation without the fresh-session
`tokenSha256` marker is not upgraded automatically. Relmio 0.14.0 refuses setup
before changing its files, Docker resources, or runtime session; migration
requires a separately reviewed path.

After reviewing the installation, copy its one-time Relmio client credential.
Set the n8n custom model URL to `http://n8n-supergrok:14502/v1`. `grok-build`
is a supported legacy alias; a workflow OpenAI-compatible model node can use
**From list** to load a fresh authenticated catalog. Turn **Use Responses API**
off for that workflow model node. Use the local credential in the field named
API key; it authorizes Relmio only, and no xAI API key is needed.

This differs from the OpenAI OAuth/Codex recipe, which uses **Use Responses API**
on in OpenAI Chat Model node version 1.3.

For self-hosted n8n versions that expose **AI Assistant settings**, use its
admin model connection settings. The n8n 2.36.8 configuration reference documents
persisted model connections that override environment defaults; these are
separate from workflow-canvas credentials. Verify that your running version
offers that setting before changing anything. Relmio does not edit or restart
an existing n8n deployment to enable it.

The n8n 2.36.8 Assistant custom-endpoint dialog uses a model text field; it
does not load a model dropdown. Enter a selected discovered routing name there.
The Assistant test passed a node-catalog tool with explicit `grok-4.6`, without
restarting n8n after saving the connection. That credential protects the
private sidecar; it is not an xAI API key or an OAuth token.

For n8n Chat Hub, turn **Use Responses API** off in **Settings > Chat > OpenAI
> Edit provider**. A plain Chat conversation then passed with the existing
Grok 4.6 workflow credential. This provider-wide Chat setting does not change
the separate Assistant connection, and Chat tool calls remain untested.

Explicit `N8N_INSTANCE_AI_MODEL`, `N8N_INSTANCE_AI_MODEL_URL`, or
`N8N_INSTANCE_AI_MODEL_API_KEY` settings can make the corresponding controls
environment-managed. n8n then refuses those admin-setting changes. Check the
existing configuration first; do not remove environment settings or restart
n8n through Relmio to bypass that restriction. The disposable test enabled
`instance-ai` with none of those three model variables set.

Source: [n8n 2.36.8 provider connection configuration](https://github.com/n8n-io/n8n/blob/n8n%402.36.8/packages/%40n8n/instance-ai/docs/configuration.md#provider-connections).

```sh
relmio grok login --n8n
```

The command starts official device sign-in in the companion's managed
runtime. Use `relmio grok logout --n8n` for explicit sign-out. A healthy runtime
alone does not prove that its account is signed in. Removal requires its own
confirmation and affects only the attested companion resources.

## Unsupported ChatGPT plan capabilities

The local plan gateway supports catalog discovery and text/image/file inputs
that the selected model and documented Responses contract accept. It does not
implement audio, transcription, video, Files API management, moderation,
stored responses/conversations, or unsupported Responses fields and tools,
including the `image_generation` tool. Image generation and editing need the
separate Codex sign-in of the VPS image add-on, which a local sidecar does not
offer. Discovery does not establish access to a model or capability. For exact
errors and recovery, see
[Configure n8n nodes](n8n-configuration.md) and the
[OpenAI source check](openai-source-check-2026-10-05.md).
