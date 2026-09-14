# Local Docker endpoints

Relmio installs isolated provider runtimes for local apps and private
companions for n8n. SuperGrok is a first-class local and VPS option with its own
official device sign-in. It does not require or read ChatGPT credentials. The
adapter remains experimental. Its seven dashboard services keep the three local
OAuth endpoints separate from the four n8n and support options.

| Wizard option | Local interface | Upstream sign-in | Intended client |
|---|---|---|---|
| **Codex App Server** | Official Codex App Server JSON-RPC over WebSocket | ChatGPT sign-in through Codex | A trusted native Codex/App Server client owned by the same person |
| **Codex Chat Adapter** | Relmio-specific HTTP `POST /chat` | ChatGPT sign-in through Codex | A trusted local backend or development server owned by the same person |
| **Grok on this computer** | Loopback `/v1/chat/completions` and simple `POST /chat` | Fresh OAuth/device sign-in through the official Grok CLI | A trusted local backend or development server owned by the same person |
| **ChatGPT for n8n** | Private `http://n8n-openai-oauth:10531/v1` on one existing Docker network | Local ChatGPT OAuth copied into a private sidecar volume | Only the selected self-hosted n8n deployment |
| **Grok for n8n** | Private `http://n8n-supergrok:14502/v1` on one existing Docker network | Separate fresh Grok OAuth session and one-time local bearer | Only the selected local or VPS n8n deployment |
| **n8n AI Assistant tools** | Private Code Sandbox plus optional SearXNG JSON search on one existing Docker network | A generated sandbox key shown once; model-provider credentials stay in n8n | Only the selected self-hosted n8n deployment |
| **Set up new n8n** | A new owned n8n stack with loopback access and a Basic-Auth-protected public ngrok route | n8n credentials stay in its owned data volume; ngrok uses an operator-supplied token | A new disposable local n8n installation and its webhooks |

Relmio does not exchange or translate a ChatGPT OAuth/session credential into
an OpenAI-compatible `/v1` bearer credential. The native Codex option keeps
Codex's thread, turn, approval, and streamed-event semantics. The adapter
translates only a small Relmio-owned `/chat` contract into that official
protocol; it does not imitate the OpenAI API. The n8n bridge is a separate,
unofficial/private compatibility path. It is not an OpenAI Platform API key,
is not exposed as a general local endpoint, and is never described as supported
or policy-approved.

These are product limits, not legal advice or a promise that an account use is
allowed. Review the agreements that apply to your account.

## ChatGPT/Codex sign-in lifetime

ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes
them automatically during active use before they expire, so active sessions
usually continue without another browser login. The official [OpenAI
authentication documentation](https://learn.chatgpt.com/docs/auth) does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Provider authentication and account switching

Relmio's Codex targets use the [official Codex App
Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints).
Codex owns the ChatGPT OAuth flow, token storage, and token refresh. Each Codex
target has one active ChatGPT account. To switch accounts, sign out of that
target and complete a new Codex sign-in. OpenAI currently documents its
[two-account switcher](https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching)
as a ChatGPT web feature and says it is not yet supported in Codex desktop.
Relmio does not keep an account pool or move requests between accounts.

Relmio 0.14.0 has no upstream API-key setup or API-key profile registry.
Existing API installations and stored data are left untouched.

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
  or Linux under WSL2. Relmio verifies an owner-only NTFS DACL before writing
  Windows credentials; POSIX hosts retain owner-only modes.
- Docker Engine or Docker Desktop with Docker Compose v2 on the local computer
- A free loopback port: `14500` for native Codex, `14501` for Codex Chat
  Adapter, or `14502` for the Grok Build adapter

- For the n8n bridge, a running official n8n container with an existing shared
  Docker network; no host port is required
- For n8n AI Assistant tools, the same running n8n and shared-network
  requirement, plus enough capacity for a privileged Docker-in-Docker runner
- For a new local n8n stack, an ngrok authtoken and reserved hostname, strong
  Basic Auth credentials, and two free loopback ports
- An eligible ChatGPT account for Codex, an existing local `openai-oauth`
  ChatGPT sign-in for the private n8n bridge, or an eligible SuperGrok account
  for the experimental official Grok Build runtime

- For loopback endpoints, a trusted local app that can keep the Relmio
  capability secret

The local path does not need a VPS or SSH access and does not modify the
existing n8n deployment. It creates a separate Relmio-managed Docker Compose
project on the local computer.

## Install with the browser wizard

1. Start Relmio on the computer that will run the endpoint. Use one of the
   commands on the [hosted install page](https://relmio.vercel.app/install),
   or run:

   ```bash
   npx --yes --ignore-scripts relmio@latest
   ```

2. Relmio opens the local dashboard through an owner-only, single-use browser
   handoff. If it does not open, press Enter in the active foreground terminal
   or run `relmio open` from a persistent install. Then select **Add connection**.
3. Choose **ChatGPT for n8n**, **Grok for n8n**, **Set up new n8n**, or
   **Grok on this computer**. Open **More connections and tools** for Codex
   endpoints and **n8n AI Assistant tools**. Expand **Connection details and
   limits** when you need the technical explanation.
4. For a local endpoint, choose an unused loopback port. For the ChatGPT n8n
   bridge, sign in locally and select the running n8n container and its Docker
   network. Assistant tools include Code Sandbox and optional SearXNG, off by
   default. For a new stack, use the [new n8n guide](./local-n8n-stack.md).

5. Review the exact bind or private-network boundary, managed path, protocol,
   and limitations. Confirm the plan before Relmio writes files or starts
   Docker.
6. For a loopback endpoint, copy the generated local capability when the result
   screen displays it.
   Relmio shows the raw capability once and persists only its SHA-256 verifier.
   “Shown once” describes the wizard display; the bearer remains valid until
   you update the endpoint to rotate it.
7. If you selected Codex, complete the device-code sign-in shown by the wizard.
   If you selected Assistant tools, copy the one-time sandbox key and returned
   companion-settings block before leaving the result screen.

## Persistent local dashboard

The standard `relmio` command opens a dashboard before the setup flow. Relmio
0.14.0 reconstructs status for three OAuth endpoints and four n8n/support
services from fixed managed directories, the selected local Docker context,
and exact Docker resource identities. It does not discover or manage retired
API-key targets.

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
```

Advanced or test environments can set `RELMIO_HOME` before starting the
wizard to an absolute managed base whose final component is `.relmio`.

Each target directory contains `.managed-by-relmio.json`. Endpoint markers
record the target, port, Docker socket URI, installation ID, and unique Compose
project name. The n8n bridge marker instead records the exact selected n8n
container and network identities. The Assistant marker also records
its generated service identities and exact SearXNG selection. No marker
contains a credential. Relmio uses that identity to distinguish its resources
from another checkout or user's resources on the same Docker Engine.

## Self-hosted n8n bridge

The n8n bridge installs only a new `openai-oauth` sidecar. Before it writes,
Relmio checks the selected n8n container, Docker network, local Docker socket,
and current OAuth credential again. The selected network must report the exact
Docker boolean `Internal: false`; an internal network cannot reach OpenAI,
SearXNG, or the sandbox runner, so Relmio asks you to choose a non-internal
network and review a fresh plan. It stops if the alias conflicts or those
values changed.

The generated Compose project contains no `ports` mapping, Traefik label, or
ngrok route. Only the sidecar joins the selected external network, under the
alias `n8n-openai-oauth`; Relmio never changes n8n's network membership or
lifecycle. The source OAuth file is preserved. Its validated JSON is copied
over stdin into a private labeled volume by a one-shot helper with networking
and logging disabled.

Configure n8n with:

```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: local-only
Responses API: On
```

If the bridge was installed before an n8n compatibility fix, updating Relmio
does not change its running container. Open the local dashboard, select the
verified **OpenAI OAuth bridge**, and choose **Manage bridge**. Read the runtime
update summary, select the separate confirmation checkbox, then choose **Update
bridge runtime**. Relmio preserves the existing OAuth credential, bridge
identity, and selected network while it rebuilds only the owned sidecar. No new
ChatGPT sign-in is needed.

**Apply sign-in to owned bridge** has a narrower job. It copies the current
ChatGPT sign-in into the owned credential volume and does not update the bridge
runtime. Neither action changes n8n or publishes port `10531`.

That URL works only from containers on the selected network. It is not
available through `127.0.0.1`, the host LAN, or ngrok. This option does not
install n8n AI Assistant's Code Sandbox or SearXNG, and it does not configure an
Assistant model-provider credential. Those remain separate, explicit choices.

Relmio refuses to use the fresh-install flow as an in-place reinstall. Its
separate runtime update and credential actions require their own confirmations.
A separately confirmed credential refresh
re-reads the protected host credential, re-attests the exact marker, n8n
container, network, owned sidecar volume, and sidecar service. It freezes the
exact owned sidecar while making a validated quiesce snapshot, proves the same
container ID stopped, then promotes a distinct rollback snapshot before it
seeds the volume and recreates only `openai-oauth`. It never restarts,
recreates, or configures n8n. Docker engines without the required Linux
container freezer fail closed without a stop fallback. If refresh or rollback
cannot be verified, Relmio preserves the journal evidence rather than guessing
or attempting to recover a credential from Docker.

Bridge and Assistant actions use a private lifecycle lock tied to the local
process creation identity, not merely a reusable PID. A stale interrupted lock
may be reclaimed only after a bounded publication grace and a nested arbitration
claim; active, ambiguous, malformed, replaced, symbolic-link, or ownership-
uncertain locks remain blocked for safe inspection.

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

For the private n8n OpenAI bridge, select **Manage bridge** after installing a
Relmio compatibility release. Read the runtime update summary, select its
confirmation checkbox, then choose **Update bridge runtime**. This replaces only
the owned sidecar runtime and keeps its existing OAuth credential, bridge
identity, and Docker network. Updating the Relmio package alone leaves the
running sidecar unchanged.

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

## Codex with ChatGPT: agent clients

The result screen provides:

```text
Endpoint: ws://127.0.0.1:14500
Authorization: Bearer <the Relmio capability shown once by the wizard>
Protocol: Codex App Server JSON-RPC
```

After installation, select the wizard's ChatGPT sign-in action, open the
official verification URL, enter the device code, and complete authentication.
Relmio starts the login through the official Codex App Server account method;
it never returns the resulting ChatGPT access or refresh tokens.

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

Possession of the Relmio capability can grant access to App Server's broad
agent and account surface inside the container, including the signed-in Codex
session and files in its private workspace; a capable client may be able to
recover the container's ChatGPT session credential. Treat the capability like
the ChatGPT credential itself. Do not give it to another user, bundle it in an
app, or expose the WebSocket on a LAN, domain, reverse proxy, or public IP.

Relmio limits the effect of that access by giving Codex a private named Docker
workspace and credential volume. The service receives no host directory,
Docker socket, SSH key, browser profile, or host home-directory mount. This
reduces host exposure; it does not make an untrusted App Server client safe.

## Codex Chat Adapter: development backends

The adapter result screen provides:

```text
Endpoint: http://127.0.0.1:14501
Authorization: Bearer <the Relmio capability shown once by the wizard>
Protocol: Relmio Codex Chat HTTP
```

After completing the same official Codex device-code sign-in, a local backend
can start a conversation. Read the bearer rather than placing it in a
shell command:

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

**Upgrading does not stop an existing API-key gateway.** This OAuth-only
version no longer discovers or manages `openai-api` or `xai-inference`.
An older container can continue listening and using its saved credential even
though it has no dashboard row. The upgrade does not migrate or delete its data.

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

The manual recovery commands below apply to the two Codex targets. Use the
reviewed management flow for the Grok target and the separately confirmed
Ready-screen removal for `n8n-openai-oauth`. These actions remove only owned
resources and never remove or disconnect the selected n8n or external network.

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
ChatGPT login and workspace. Keep the managed target directory and marker as
well; they preserve the ownership identity needed to safely reuse or later
delete those volumes. Never remove the parent `~/.relmio`, use a wildcard, or
remove the other target.



### Permanently delete Codex credentials and workspace

Back up anything intentionally retained from the private Codex workspace and
confirm you want to erase its ChatGPT login. Then repeat the marker and label
checks and run this exact project-scoped command:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  down --volumes
```

`--volumes` irreversibly deletes the managed Codex home and workspace volumes,
including the container's ChatGPT credentials. After Docker confirms the
matching resources are gone, you may remove only the exact
`~/.relmio/local/codex-chatgpt` or `~/.relmio/local/codex-chat` managed
directory for the target you verified through your file manager.

## Troubleshooting

- **Docker unavailable:** start Docker Desktop or the Docker daemon and verify
  `docker version` and `docker compose version` locally.
- **Port already in use:** choose another unprivileged port in the wizard and
  review the updated endpoint before confirming.
- **`401` from the local adapter:** use the Relmio bearer shown once at setup.
  That bearer protects the local connection; it is not a provider API key.

- **Browser cannot connect to Codex:** this is expected. Both Codex targets
  reject browser-origin requests. Use the raw App Server from a trusted native
  client or keep the Chat Adapter bearer in a local backend.
- **Codex reports signed out:** repeat the device-code sign-in in the local
  wizard. Never copy a Codex credential file between users.
- **Native Windows security check failed:** select Docker Desktop's
  `desktop-linux` context and retry. Relmio must be able to create and read back
  a protected current-account-only NTFS DACL; it makes no Docker change when
  that check fails. WSL2 remains a supported fallback.

## Official sources and account terms

This design follows the currently documented distinction between Platform API
credentials and Codex/ChatGPT authentication:

- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex permission profiles](https://learn.chatgpt.com/docs/permissions)
- [Codex App Server protocol and WebSocket limitations](https://learn.chatgpt.com/docs/app-server)
- [Codex for Open Source program terms](https://learn.chatgpt.com/docs/codex-for-oss-terms)

Acceptance into Codex for Open Source can provide program benefits, but Relmio
does not interpret membership as permission to repurpose ChatGPT credentials
for general API calls, share an account, bypass safeguards, or alter the scope
of another OpenAI agreement. The local Codex option stays inside the official
Codex protocol. Ordinary API-key integrations belong in the consuming client.

Relmio never changes accounts automatically. Changing a provider account requires
an explicit sign-out and fresh sign-in.

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

## GPT Image 2.5 in n8n

A new OpenAI OAuth bridge includes `gpt-image-2.5-flare` and
`gpt-image-2.5-sunburst` in model discovery. For an existing managed bridge,
use its reviewed browser runtime-update action to install the current adapter;
upgrading only the Relmio dashboard does not update an already running bridge.
The local update preserves its saved sign-in. A VPS update follows its separate
reviewed sign-in upload flow. Both paths leave n8n unchanged.

The completion screen shows image IDs from the verified model response. In
n8n's OpenAI node, select **Image**, then **Generate an Image** or **Edit Image**,
and pick the exact model from the list. Use **By ID** when needed by your n8n
version. Existing `gpt-image-2` remains available. Do not use the generic
`gpt-image-2.5` as a model ID or select an image model for a text-chat recipe.

Both variants passed bounded generation and editing tests. Exact output
size and all options remain unverified; begin with low quality. Discovery is
not a promise of account entitlement. Live, Realtime and audio are separate
capabilities and remain unsupported through this bridge.
