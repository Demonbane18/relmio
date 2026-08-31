# Local Docker endpoints

Relmio can install a provider endpoint in Docker on the same computer as your
app, or add a private model bridge beside an existing local n8n container. The
local installer keeps six explicit contracts separated by provider
authentication method and network boundary:

| Wizard option | Local interface | Upstream sign-in | Intended client |
|---|---|---|---|
| **OpenAI API: compatible clients** | OpenAI-compatible HTTP under `/v1` | Server-side OpenAI Platform API key only | A private local app, SDK, or same-owner development web app |
| **Codex with ChatGPT: agent clients** | Official Codex App Server JSON-RPC over WebSocket | ChatGPT sign-in through Codex | A trusted native Codex/App Server client owned by the same person |
| **Codex Chat Adapter: development backends** | Relmio-specific HTTP `POST /chat` | ChatGPT sign-in through Codex | A trusted local backend or development server owned by the same person |
| **Self-hosted n8n bridge** | Private `http://n8n-openai-oauth:10531/v1` on one existing Docker network | Local ChatGPT OAuth copied into a private sidecar volume | Only the selected self-hosted n8n deployment |
| **n8n AI Assistant tools** | Private Code Sandbox plus optional SearXNG JSON search on one existing Docker network | A generated sandbox key shown once; model-provider credentials stay in n8n | Only the selected self-hosted n8n deployment |
| **New local n8n + ngrok** | A new owned n8n stack with loopback access and a Basic-Auth-protected public ngrok route | n8n credentials stay in its owned data volume; ngrok uses an operator-supplied token | A new disposable local n8n installation and its webhooks |

Relmio does not exchange or translate a ChatGPT OAuth/session credential into
an OpenAI-compatible `/v1` bearer credential. The native Codex option keeps
Codex's thread, turn, approval, and streamed-event semantics. The adapter
translates only a small Relmio-owned `/chat` contract into that official
protocol; it does not imitate the OpenAI API. The n8n bridge is a separate,
unofficial/private compatibility path. It is not an OpenAI Platform API key,
is not exposed as a general local endpoint, and is never described as supported
or policy-approved.

This is a documentation-backed engineering boundary, not legal advice or a
guarantee that a particular account or use case is permitted. Review the
agreements and policies that apply to your account.

## ChatGPT/Codex sign-in lifetime

ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes
them automatically during active use before they expire, so active sessions
usually continue without another browser login. The official [OpenAI
authentication documentation](https://learn.chatgpt.com/docs/auth) does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Requirements

- macOS, Linux, or Linux under WSL2. Native Windows is not supported because
  this release depends on POSIX owner-only directory and file permissions for
  local credentials.
- Docker Engine or Docker Desktop with Docker Compose v2 on the local computer
- For a loopback endpoint, a free local port (`12435` for OpenAI API, `14500`
  for native Codex, or `14501` for the Codex Chat Adapter by default)
- For the n8n bridge, a running official n8n container with an existing shared
  Docker network; no host port is required
- For n8n AI Assistant tools, the same running n8n and shared-network
  requirement, plus enough capacity for a privileged Docker-in-Docker runner
- For a new local n8n stack, an ngrok authtoken and reserved hostname, strong
  Basic Auth credentials, and two free loopback ports
- One of these provider credentials:
  - an OpenAI Platform API key for the OpenAI-compatible endpoint; or
  - a ChatGPT account eligible for Codex for either Codex target; or
  - an existing local `openai-oauth` ChatGPT sign-in for the private n8n bridge
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

2. Open the one-time local wizard URL printed in the terminal and choose
   **Local endpoints**.
3. Choose one of the three loopback endpoints, **Self-hosted n8n bridge**,
   **n8n AI Assistant tools**, or **New local n8n + ngrok**.
4. For a loopback endpoint, keep the default port or select another unused
   local port. For the OpenAI API option, add any browser origins that must be
   allowed and enter your Platform API key. For the n8n bridge, sign in with
   ChatGPT locally, then explicitly choose the running n8n container and shared
   Docker network discovered by Relmio. For Assistant tools, choose whether to
   add SearXNG JSON web search; it is off by default and Code Sandbox is always
   included. For a new n8n stack, follow the dedicated
   [new local n8n + ngrok guide](./local-n8n-stack.md).
5. Review the exact bind or private-network boundary, managed path, protocol,
   and limitations. Confirm the plan before Relmio writes files or starts
   Docker.
6. For a loopback endpoint, copy the generated local capability when the result
   screen displays it.
   Relmio shows the raw capability once and persists only its SHA-256 verifier.
   “Shown once” describes the wizard display; the bearer remains valid until
   you update the endpoint to rotate it.
7. If you selected Codex, complete the device-code sign-in shown by the wizard.
   If you selected Assistant tools, copy the one-time sandbox key and complete
   n8n environment block before leaving the result screen.

Relmio refuses to overwrite an existing unmanaged directory or use a symlink
inside its managed path. Its local files live under:

```text
~/.relmio/local/openai-api
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
container and network identities. The Assistant marker additionally records
its generated service identities and exact SearXNG selection. No marker
contains a credential. Relmio uses that identity to distinguish its resources
from another checkout or user's resources on the same Docker Engine.

## Self-hosted n8n bridge

The n8n bridge installs only a new `openai-oauth` sidecar. The reviewed plan is
bound to the selected running n8n container ID/name, Docker network ID/name,
local Docker socket, and current OAuth credential generation. Relmio rechecks
those values immediately before mutation and rejects network-alias collisions
or drift.

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

That URL works only from containers on the selected network. It is not
available through `127.0.0.1`, the host LAN, or ngrok. This option does not
install n8n AI Assistant's Code Sandbox or SearXNG, and it does not configure an
Assistant model-provider credential. Those remain separate, explicit choices.

The n8n bridge is create/remove-only in this release. Relmio refuses an
in-place reinstall so a failed refresh cannot tear down a previously working
bridge or its private OAuth volume. Use the Ready screen's separately confirmed
**Remove bridge** action, then prepare and approve a fresh plan.

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

The result screen returns an environment block shaped like this, using the
generated private URL and one-time key from that installation:

```text
N8N_ENABLED_MODULES=instance-ai
N8N_INSTANCE_AI_SANDBOX_ENABLED=true
N8N_INSTANCE_AI_SANDBOX_PROVIDER=n8n-sandbox
N8N_INSTANCE_AI_SANDBOX_IMAGE=<immutable Relmio-reviewed sandbox image>
N8N_SANDBOX_SERVICE_URL=http://relmio-ai-sandbox-<generated-id>:8080
N8N_SANDBOX_SERVICE_API_KEY=<shown once>
N8N_INSTANCE_AI_SEARXNG_URL=http://relmio-ai-searxng-<generated-id>:8080
```

The final SearXNG line is present only when web search was selected. If
`N8N_ENABLED_MODULES` already contains other modules, preserve them and merge
`instance-ai` as a comma-delimited entry instead of replacing the existing
value. Apply these values and restart n8n through your own deployment workflow;
Relmio does not change or restart n8n. Configure the AI model provider and its
credential directly in n8n.

The privileged runner is intended for local development and testing. Use
n8n's recommended Daytona sandbox path for production. The Ready screen's
separately confirmed **Remove n8n Assistant tools** action removes only the
owned companion project and local managed files; the selected external network
and n8n container remain untouched.

## Safe updates and credential rotation

To replace only the credential used by your local client, select **Rotate client
credential** on the installed endpoint's Ready screen. Relmio first stages and
shows the new one-time capability while the previous capability remains active.
It then updates and validates the managed Compose configuration, recreates only
the attested service, and verifies the new bearer against `/v1/models`, the
authenticated Codex WebSocket handshake, or the adapter's authenticated probe
before reporting success.

This client-only rotation preserves the upstream Platform API key in its private
named volume and preserves the Codex home and workspace volumes. If activation
or verification fails, Relmio restores the previous verifier and re-attests its
health and loopback publication. Relmio does not retain the previous raw client
credential, so rollback does not replay an authenticated request with it. If
that rollback cannot be confirmed, Relmio attempts to stop only the exact
managed service and reports whether the stopped state could be verified.

Rerun the browser wizard with the same target and port when you need a complete
managed update. Relmio verifies the marker and Docker resource ownership and
reuses the installation's unique Compose identity. For `openai-api`, provide the
current or replacement Platform API key during that full update; Relmio reseeds
its private named volume independently from the local client capability. A full
`codex-chatgpt` or `codex-chat` update retains the private Codex home and
workspace volumes unless you explicitly delete them.

Do not hand-edit the marker, Compose file, credential volume, or verifier. If
the marker or resource labels do not attest as one Relmio installation, the
wizard stops without overwriting them.

## OpenAI API: compatible clients

The result screen provides:

```text
Base URL: http://127.0.0.1:12435/v1
API key field: <the Relmio local capability shown once by the wizard>
```

Use the Relmio capability shown once by the wizard, not the upstream Platform
key, in your local
client's API-key field. The gateway authenticates the local request with that
capability, replaces its authorization header with the protected Platform key,
and forwards only `GET /v1/models`, `POST /v1/responses`, and
`POST /v1/chat/completions` to `https://api.openai.com`.

For a quick private test:

```bash
export RELMIO_LOCAL_KEY="<capability shown once by the wizard>"
printf 'Authorization: Bearer %s\n' "$RELMIO_LOCAL_KEY" |
  curl http://127.0.0.1:12435/v1/models --header @-
unset RELMIO_LOCAL_KEY
```

The upstream key is passed only over stdin to a transient, network-disabled
seed helper, which atomically writes it into a private, labeled Docker volume.
The gateway mounts that volume read-only. Relmio does not create a host key
file, put the key in the generated Compose environment, return it from the
wizard, forward it from the client, or use it for the Codex option. OpenAI's
API documentation says API credentials are secrets and should not be exposed
in client-side code. Treat the local capability the same way.

### Browser origins

Native clients and local backends normally send no `Origin` header and can use
the endpoint after bearer authentication. A browser request is allowed only
when its exact `http` or `https` origin was entered during setup. For example,
`http://localhost:3000` and `http://127.0.0.1:3000` are different origins.

Relmio does not accept wildcard origins, `null`, credentials, paths, queries,
or fragments. An allowed origin is a cross-origin request control, not a
secret-storage system: JavaScript, browser extensions, or anyone who can read
the page can still recover a bearer value embedded in a frontend bundle. Use
browser access only for a private, same-owner local development app. Prefer a
native client or a local backend when the capability must remain confidential.

### Billing and credits

Requests use the OpenAI Platform project associated with the supplied API key
and are billed or credited there under the Platform account's current terms,
limits, and pricing. A ChatGPT subscription or Codex for Open Source benefit
is not substituted for Platform API billing on this route. OpenAI documents
API-key use as usage-based access and ChatGPT sign-in as subscription access in
its [Codex authentication guide](https://learn.chatgpt.com/docs/auth).

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
OpenAI SDKs and tools that require those schemas still need the Platform-backed
OpenAI API target. The adapter rejects every request carrying an `Origin`
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
while the adapter is working; the tester reports success only after the
completed terminal event arrives.

## Network and container boundary

Each of the three loopback endpoint projects publishes exactly one host
mapping:

```text
127.0.0.1:<selected-port>:<container-port>
```

They are not available through the computer's LAN address. Each long-running
service runs as a non-root user, drops Linux capabilities, sets
`no-new-privileges`, uses a read-only root filesystem, and has bounded
temporary storage and resource limits. None of the services mounts the Docker
socket or a general host directory. The one-shot OpenAI seed helper has no
network, port, or logs and retains only `CHOWN` while running as root long
enough to atomically set ownership on the volume entry.
The OpenAI gateway receives only its private API-key named volume, mounted
read-only; both Codex targets receive no host path and use target-specific
private named volumes.

The n8n sidecar publishes no host mapping. It receives only its private OAuth
volume and the reviewed external n8n network. It does not mount the Docker
socket or any host path, and only its container is created or removed by this
flow.

The loopback binding and capability are complementary controls. Other
processes running as the same local user may still be able to reach a loopback
port, so protect the capability and keep the computer itself trusted.

## Recovery and uninstall

The manual recovery commands below apply only to the three loopback endpoint
targets. For `n8n-openai-oauth`, use the Ready screen's separately confirmed
**Remove bridge** action. It attests and removes only the sidecar Compose
project, private auth volume, image, and managed directory; it never removes or
disconnects n8n or the selected external network.

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
`gateway` for `openai-api`, `codex` for `codex-chatgpt`, or `codex-chat`
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

Confirm all three labels—`io.relmio.managed=true`, the exact target, and the
exact installation ID—match the marker. If any label or identity differs,
stop. Only after they all match may you stop and remove the one managed
service:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  rm --stop --force <gateway-or-codex-or-codex-chat>
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

### Permanently uninstall the OpenAI API endpoint

After repeating the OpenAI target's marker and label checks, delete its one
managed service, project network, and API-key volume with the exact
project-scoped command:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  down --volumes
```

For this target, `--volumes` irreversibly deletes the private volume containing
the Platform API key. After Docker confirms that every matching labeled
resource is gone, you may remove only the exact
`~/.relmio/local/openai-api` managed directory through your file manager.

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
- **`401` from `/v1`:** use the Relmio capability shown by the wizard in the
  client's bearer/API-key field. Do not send the Platform key to the local
  endpoint.
- **Browser request rejected:** enter the exact page origin, including scheme
  and port, then update the managed endpoint. Wildcards are intentionally not
  supported.
- **Browser cannot connect to Codex:** this is expected. Both Codex targets
  reject browser-origin requests. Use the raw App Server from a trusted native
  client or keep the Chat Adapter bearer in a local backend.
- **Codex reports signed out:** repeat the device-code sign-in in the local
  wizard. Never copy a Codex credential file between users.
- **Native Windows:** this local Docker feature is unsupported. Run Relmio in a
  POSIX environment such as WSL2, or use macOS/Linux; do not weaken credential
  permissions to force an install.

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
Codex protocol; general `/v1` calls continue to require Platform credentials.
