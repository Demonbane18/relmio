# Spec: Policy-safe local endpoints

## Status

Originally approved on 2026-08-13, extended for the additive
`codex/local-codex-chat-adapter` target on 2026-08-15, and extended on
2026-08-31 for private local n8n sidecar and AI Assistant companion options.

This spec is product and engineering guidance based on the current official
OpenAI documentation. It is not a legal opinion. Relmio must not claim that
OpenAI has endorsed, certified, or pre-approved the project.

## Objective

Add a local Docker installation path to the Relmio browser wizard without
weakening the existing VPS/n8n safety boundary.

Relmio offers three intentionally different loopback client contracts plus two
private n8n-only companion contracts:

1. `openai-api` is an OpenAI-compatible HTTP gateway backed by the user's
   OpenAI Platform API key.
2. `codex-chatgpt` is the official Codex App Server protocol backed by the
   user's ChatGPT/Codex sign-in.
3. `codex-chat` is a small Relmio-specific HTTP chat adapter backed by the
   same official App Server lifecycle and ChatGPT/Codex sign-in.
4. `n8n-openai-oauth` is an explicitly unofficial/private compatibility
   sidecar reachable only from an existing selected n8n Docker network.
5. `n8n-ai-assistant` installs Code Sandbox and an explicit optional SearXNG
   JSON-search service on the selected existing n8n Docker network.

Relmio must never exchange, translate, or present a ChatGPT/Codex credential as
a general OpenAI API bearer credential. Neither Codex target may expose an
OpenAI-shaped `/v1` compatibility surface. The adapter owns only its narrow
`POST /chat` contract.

The n8n sidecar is not the local Platform-backed `/v1` gateway and is not a
general local-client endpoint. It uses the existing `openai-oauth` compatibility
helper, has no host publication, and must remain visibly labeled unofficial and
policy-uncertain.

## Official-source boundary

- General OpenAI API requests use a Platform API key (or an officially
  supported workload identity credential).
- ChatGPT subscription access stays inside the official Codex CLI/App Server
  workflow.
- Codex App Server uses its native JSON-RPC thread, turn, approval, and event
  protocol.
- Codex App Server WebSocket transport is experimental and unsupported for
  production workloads. Relmio must display that limitation before install and
  in the result screen.
- Codex for Open Source benefits remain personal, limited, and governed by the
  program terms. Program acceptance does not become a generic credential-scope
  waiver.

Primary references:

- <https://learn.chatgpt.com/docs/app-server>
- <https://learn.chatgpt.com/docs/auth>
- <https://learn.chatgpt.com/docs/enterprise/access-tokens>
- <https://developers.openai.com/api/reference/overview#authentication>
- <https://learn.chatgpt.com/docs/codex-for-oss-terms>

## User experience

The existing VPS/n8n wizard remains a separate legacy setup path. The wizard
landing experience adds a prominent **Local endpoints** option which opens a
dedicated local installer.

The local installer starts with five provider cards:

### OpenAI API

- Label: **OpenAI API, compatible clients**
- Default HTTP port: `12435`
- Requires an OpenAI Platform API key beginning with `sk-`.
- Accepts zero or more exact browser origins. No wildcard origin is allowed.
- Result:
  - Base URL: `http://127.0.0.1:<port>/v1`
  - A newly generated Relmio bearer key, displayed once
  - A warning that the upstream Platform API key is seeded over stdin into a
    private labeled Docker volume, never written to a host file, and never
    returned by the wizard

### Codex with ChatGPT

- Label: **Codex with ChatGPT, agent clients**
- Default WebSocket port: `14500`
- Uses pinned official `@openai/codex@0.147.0`.
- Result:
  - Endpoint: `ws://127.0.0.1:<port>`
  - A newly generated capability token, displayed once
  - A device-code sign-in action using `account/login/start` with
    `{ "type": "chatgptDeviceCode" }`
  - An explicit statement that this is Codex JSON-RPC, not OpenAI `/v1`
  - An explicit experimental/non-production notice

### Codex Chat Adapter

- Label: **Codex Chat Adapter, development backends**
- Default HTTP port: `14501`
- Uses the same pinned official Codex CLI and official device-code sign-in.
- Result:
  - Endpoint: `http://127.0.0.1:<port>`
  - A newly generated Relmio bearer token, displayed once
  - A device-code sign-in action
  - An explicit server-side-only statement
  - An explicit statement that `POST /chat` is Relmio-specific, not OpenAI
    `/v1`
  - An explicit experimental/non-production notice

### Self-hosted n8n bridge

- Label: **Self-hosted n8n bridge**
- Meta: **Unofficial · private Docker network**
- Requires an existing local ChatGPT OAuth credential, one running official
  n8n container, and an explicit shared-network selection.
- Has no port, browser-origin, generated client-credential, rotation, Codex
  login, or Chat Adapter tester controls.
- Result:
  - Base URL: `http://n8n-openai-oauth:10531/v1`
  - API-key placeholder: `local-only`
  - Responses API: on
  - Exact selected network and verified model IDs
  - Host publication: none
  - A warning that only containers on the selected network can use the URL
- The review states that Relmio will not edit, exec into, rebuild, restart,
  stop, recreate, or connect a network to n8n; publish `10531`; create an ngrok
  or Traefik route; or install the AI Assistant Code Sandbox/SearXNG.

### n8n AI Assistant tools

- Label: **n8n AI Assistant tools**
- Meta: **Code Sandbox + optional SearXNG**
- Requires one running official n8n container and an explicit shared-network
  selection. It never reads the local ChatGPT OAuth credential.
- Code Sandbox is always included. SearXNG JSON web search is an exact boolean,
  off by default, and bound to the reviewed plan.
- Result:
  - Stable generated sandbox URL and one-time sandbox API key
  - Optional stable generated SearXNG URL
  - Exact n8n environment block for `instance-ai`, sandbox provider/image,
    sandbox URL/key, and optional SearXNG URL
  - Host publication: none
- The review states that the runner is privileged for local testing, Daytona is
  recommended for production, and Relmio will not change or restart n8n.

All five flows show a review screen and require a final confirmation before any
filesystem or Docker write.

This release supports macOS, Linux, and Linux under WSL2. Native Windows is
unsupported because its filesystem permission model does not provide the POSIX
owner-only protection this installer requires. The UI and documentation must
say so, and the installer must reject native Windows before any write.

## Wizard API contract

Every wizard API route continues to require the existing `X-Setup-Token` and
same-origin protections.

### Chat Adapter tester APIs

The tester is available only after a live `codex-chat` installation reaches the
Ready screen. Sanitized preview mode rejects all three routes. Each route uses
the same `POST` exact-Origin and `X-Setup-Token` protections as the rest of
the local wizard.

- `POST /api/local/chat-test/key` returns only `keyId`, an RSA public JWK,
  `RSA-OAEP-256`, and an expiry. Its private key remains only in the local
  server's bounded, in-memory tester-session map.
- `POST /api/local/chat-test/message` accepts a literal loopback adapter base
  URL, `keyId`, RSA-OAEP SHA-256 ciphertext, a bounded input, and an optional
  bounded conversation ID. It returns only validated `conversationId` and
  `output`.
- `POST /api/local/chat-test/reset` invalidates the specified in-memory key.

The browser sends no adapter request and stores no tester data in browser
storage. It clears the plaintext credential input before it awaits key issuance
or encryption, then retains ciphertext and key ID only in page memory. The
server does not retain prompts or transcript beyond a single request.

The local proxy accepts only `http://127.0.0.1:<1-65535>` with an optional
trailing slash. It rejects DNS names, IPv6, credentials, query strings,
fragments, paths, redirects, malformed JSON, oversized request/response data,
expiry, and concurrent use. It appends `/chat`, uses a bounded timeout, sends
no `Origin` header, and returns generic redacted failures.

### `GET /api/local/docker/status`

Returns local Docker and Compose availability. It never returns filesystem
paths containing the user's home directory.

```json
{
  "dockerAvailable": true,
  "dockerVersion": "27.0.0",
  "composeVersion": "2.29.0"
}
```

### `GET /api/local/n8n/discover`

Returns only sanitized running official n8n containers and the exact Docker
networks they already join. Each option carries a container ID/name and network
ID/name used for selection. The active local Docker socket and OAuth path never
enter the browser response. Disposable harness networks may carry a warning,
and a private Assistant network is recommended ahead of a network that also
contains ngrok.

### `POST /api/local/plan`

Request:

```json
{
  "target": "openai-api",
  "port": 12435,
  "allowedOrigins": ["http://localhost:3000"]
}
```

The request never contains an upstream credential. The response contains an
opaque, single-use `planId` and the validated binding, managed path alias,
compatibility type, authentication type, and caveats.

For `n8n-openai-oauth`, the request contains only `target`,
`n8nContainerId`, and `dockerNetworkId`. Server-side discovery resolves and
binds the exact names, IDs, local Docker socket, and current OAuth credential
generation to the plan. The safe response reports the private endpoint,
network, no-host-publication boundary, managed path alias, and unofficial
status; it never reports the OAuth path or contents.

For `n8n-ai-assistant`, the request also contains the exact boolean
`includeSearxng`. The safe response reports Code Sandbox as required, optional
search status, the selected n8n/network identities, owner-managed path, no host
publication, privileged-runner warning, and operator-owned n8n configuration.

### `POST /api/local/install`

Request fields:

- `planId`: the opaque identifier returned by the most recent reviewed plan
- `apiKey`: required only for `openai-api`; accepted only in request memory
- `confirmed`: must be exactly `true`

The server consumes the plan before attempting installation, so callers cannot
change the reviewed target, port, or origins or replay a failed attempt.
The response never includes the upstream Platform API key or ChatGPT
credential. It includes the new local capability once.

For `n8n-openai-oauth`, no API key or OAuth material is accepted from the
browser. The installer reads and validates the already-signed-in local OAuth
file server-side, re-attests the plan, copies it over stdin into a private
volume, and returns only the private base URL, `local-only` placeholder,
Responses API setting, selected network, verified models, and deployment mode.

For `n8n-ai-assistant`, no provider credential is accepted. The installer
re-attests the selected n8n/network, starts only its generated owned companion
project, verifies exact services, sandbox health, no host publication, and
optional SearXNG JSON, then returns only the one-time sandbox key and exact n8n
settings. It never applies those settings or restarts n8n.

Only one installation may execute in a wizard process at a time. A concurrent
attempt receives `409` without consuming its reviewed plan. The in-flight lock
is released in a `finally` path after both success and failure.

### `POST /api/local/n8n/remove`

Requires a separate exact confirmation and the same global local-mutation lock.
The service must attest the marker, Compose project, container, and private auth
volume before it removes them. It never removes or disconnects the external
n8n network, and it never targets the selected n8n container. Uncertain
ownership fails closed and preserves the marker for recovery.

### `POST /api/local/n8n/assistant/remove`

Requires a separate exact confirmation and the same local-mutation lock. It
attests and removes only the owned Assistant project and managed files. It does
not remove or disconnect the external n8n network or target n8n.

### `POST /api/local/codex/login`

Starts an official Codex App Server device-code login through a one-shot stdio
App Server process attached to the selected Codex target's persistent home
volume. The request identifies either `codex-chatgpt` or `codex-chat`;
every other target is rejected before process construction.

Every login attempt resolves the managed Codex directory and attests its
schema-2 marker and matching Docker resources, even in a fresh wizard process.
The server passes only the attested Docker host and unique project name to the
stdio login service. An in-memory "installed" flag is not sufficient. Preview
mode and rate-limit guards run before attestation.

Response:

```json
{
  "verificationUrl": "https://auth.openai.com/...",
  "userCode": "ABCD-EFGH"
}
```

### `GET /api/local/codex/login/status`

Returns `idle`, `pending`, `success`, or `error`. Errors are sanitized; raw
App Server output is never returned.

## Local OpenAI gateway contract

### Listener

- Container listener: `0.0.0.0:10531`
- Host publication: `127.0.0.1:<selected-port>:10531`
- A generated Compose file containing `0.0.0.0:<port>` or an unqualified
  `<port>:<port>` mapping is invalid.

### Authentication

- Relmio generates 32 random bytes and returns the base64url capability once.
- Only the SHA-256 verifier is persisted.
- Every operation that can reach `/v1` upstream requires
  `Authorization: Bearer <Relmio capability>`. An exact-origin `OPTIONS`
  preflight is the sole unauthenticated, non-forwarding metadata exception.
- Comparison uses a constant-time operation.
- The upstream OpenAI key replaces, and is never combined with, the client's
  Authorization header.

### Proxy behavior

- The upstream origin is fixed to `https://api.openai.com`.
- Only `GET /v1/models`, `POST /v1/responses`, and
  `POST /v1/chat/completions` are forwarded.
- `CONNECT`, `TRACE`, absolute-form URLs, protocol-relative URLs, invalid Host
  headers, and oversized headers are rejected.
- Hop-by-hop, cookie, forwarding, proxy-authorization, origin, and referrer
  headers are not forwarded upstream.
- Response status, supported end-to-end headers, streaming bodies, client
  cancellation, and backpressure are preserved.
- Upstream `429` responses and `Retry-After` are passed through unchanged.
- Local overload responses use `429` and never retry upstream automatically.

### Browser origin policy

- Requests without `Origin` are accepted after bearer authentication.
- Browser requests require an exact configured `http` or `https` origin.
- Wildcards, `null`, credentials, paths, queries, and fragments are rejected.
- Preflight allows only the configured origin and a small documented header
  list.
- Browser credentials are still caller secrets; Relmio must not encourage
  embedding the local key in a public frontend bundle.

### Health

- `GET /health` is the only unauthenticated gateway route.
- It returns only local process readiness and no provider/account details.

## Codex App Server contract

The container command is equivalent to:

```text
codex app-server
  --strict-config
  --listen ws://0.0.0.0:4500
  --ws-auth capability-token
  --ws-token-sha256 <sha256-verifier>
```

The host mapping is exactly `127.0.0.1:<selected-port>:4500`.

- `CODEX_HOME` is a private named Docker volume.
- Credential storage is forced to file mode inside the container so refreshed
  credentials remain in the private volume.
- Login mode is forced to ChatGPT.
- Root-owned managed requirements allow only Relmio's network-disabled
  permission profile (which extends Codex's built-in workspace profile),
  on-request/user-reviewed approvals, disabled web search, no login shell, and
  a closed set of optional features. Clients cannot request
  `danger-full-access` or approval policy `never`.
- An empty named workspace volume is mounted; no host source directory, Docker
  socket, SSH key, browser profile, or home directory is mounted.
- `GET /readyz` is the Docker readiness probe.
- The client sends `Authorization: Bearer <capability>` during WebSocket
  upgrade, then `initialize`, `initialized`, `account/read`, and the normal
  thread/turn protocol.
- Relmio does not inject or return raw ChatGPT OAuth tokens through the wizard.
  Raw App Server is a high-trust surface: possession of its capability can
  control the isolated container and may expose the signed-in ChatGPT session.
  The capability is therefore password-equivalent and limited to a trusted,
  same-owner native client.

## Codex Chat Adapter contract

The adapter container starts a dependency-free Node HTTP service and launches
the pinned official `codex app-server --strict-config --stdio` process only
for a bounded chat operation. It uses the target's private Codex home and
workspace volumes and never exposes the App Server transport on the host.

### Listener and authentication

- Container listener: `0.0.0.0:14501`
- Host publication: `127.0.0.1:<selected-port>:14501`
- `GET /health` is the only unauthenticated, non-forwarding route.
- Every route except `GET /health` requires exactly one
  `Authorization: Bearer <Relmio capability>` header.
- Only the SHA-256 verifier is persisted and comparison is constant-time.
- Requests with an `Origin` header are rejected and no CORS permission is
  emitted.

### Request and response

The accepted JSON object contains only:

```json
{
  "input": "Required nonempty conversational input",
  "conversationId": "Optional App Server thread ID"
}
```

The successful response contains only:

```json
{
  "conversationId": "The started or resumed thread ID",
  "output": "The authoritative final agent message"
}
```

The adapter performs `initialize`, `initialized`, `thread/start` or
`thread/resume`, and `turn/start`. The turn is constrained to the empty
private workspace with a read-only sandbox. Its filesystem policy denies root
by default, permits only Codex's minimal runtime paths and `/workspace`, and
explicitly denies `/home/node/.codex`; turn network access is disabled. The
instruction not to inspect or modify files, run commands, call tools, or access
external resources remains defense in depth, not the credential boundary.
`item/completed` agent-message text is authoritative; bounded deltas are kept
separate by `itemId`, with only the most recent item's text used as a
compatibility fallback. Success requires `turn/completed` with
`status: completed`.

### Resource and failure bounds

- Header, body, input, conversation ID, stdout, stderr, line, and output sizes
  are bounded.
- Concurrent chats, turn duration, child-process termination grace, and the
  final wait for an unreaped process are bounded. The concurrency slot remains
  occupied until the helper closes or that final bound expires.
- Client disconnect, timeout, malformed protocol, overflow, and failed turns
  terminate the helper.
- HTTP errors are generic and never include App Server output, process errors,
  ChatGPT credentials, or stderr.
- Installation and credential rotation verify readiness/authentication without
  starting a model turn or requiring sign-in before the device-code step.

## Local filesystem and process boundary

Managed roots:

- `~/.relmio/local/openai-api`
- `~/.relmio/local/codex-chatgpt`
- `~/.relmio/local/codex-chat`
- `~/.relmio/local/n8n-openai-oauth`
- `~/.relmio/local/n8n-ai-assistant`

`RELMIO_HOME` may replace `~/.relmio` for testing or advanced use, but it must
be an absolute path whose final component is `.relmio`.

Controls:

- Managed directories use mode `0700`; generated files use owner-only modes.
- The Platform API key is seeded over stdin by a transient, network-disabled
  helper into a private labeled named volume and is never written to a host
  file or Compose environment value.
- Existing unmanaged directories are never overwritten.
- Symlinks in a managed path are rejected.
- A schema-2 JSON marker identifies the target, configured port, validated
  Docker host, 32-hex-character install ID, and collision-resistant Compose
  project name; it contains no secrets.
- Docker is invoked with argument arrays and `shell: false`.
- The command allowlist is scoped to the selected Relmio Compose project and
  service.
- No local command targets the n8n container lifecycle. The sidecar flow may
  inspect the reviewed n8n container/network and target only its own managed
  `n8n-openai-oauth` Compose project.
- The n8n bridge is create/remove-only in this release. A second install
  refuses the existing managed marker before Docker mutation; the user must
  separately confirm **Remove bridge** and then approve a fresh plan.
- Assistant tools are also create/remove-only. A second install refuses the
  existing marker; removal requires its own confirmation and exact ownership
  attestation.
- Local port availability is checked before a new install or a port change.
- Upstream credentials are cleared from request objects after installation
  completes or fails.
- Native Windows is rejected before filesystem or Docker writes because the
  required POSIX owner-only modes cannot be enforced there.

## Container hardening

All three long-running loopback endpoint services:

- run as a non-root user;
- set `no-new-privileges`;
- drop all Linux capabilities;
- use a read-only root filesystem;
- use bounded tmpfs, PID, memory, and CPU resources;
- have no Docker socket or host filesystem mount;
- publish one explicit loopback port only;
- use pinned application dependencies.

The OpenAI install also invokes a one-shot credential seed helper. It has no
network or published port, disables logging, uses the same read-only image,
sets `no-new-privileges`, and has tight CPU, memory, and PID limits. It runs as
root only long enough to replace the volume entry atomically and retains only
the `CHOWN` capability needed to make that entry readable by the non-root
gateway; it is removed immediately after seeding.

The n8n sidecar follows the same non-root, read-only-root, dropped-capability,
bounded-resource controls but has no `ports` mapping. Its separate OAuth seed
helper receives validated JSON only over stdin, has `network_mode: none`, uses
no logging, and writes only the private labeled auth volume. The long-running
sidecar joins exactly one selected external n8n network with the
`n8n-openai-oauth` alias. No service mounts the Docker socket.

The Assistant project has no host `ports` mapping. Its API and optional
SearXNG service join the selected external network under collision-resistant
generated aliases. The privileged Docker-in-Docker runner stays on its owned
internal network and is explicitly limited to local development and testing.

## Threat model

### Assets

- OpenAI Platform API key
- Codex/ChatGPT refresh and access credentials in the Codex volume
- ChatGPT OAuth credentials copied into the n8n sidecar's private auth volume
- generated local capability tokens
- user prompts, outputs, and Codex thread history
- local applications that trust the endpoint

### Trust boundaries

- browser wizard to loopback wizard server
- wizard process to local filesystem
- wizard process to Docker Engine
- local client to published loopback endpoint
- gateway to `api.openai.com`
- Codex App Server to OpenAI's Codex services

### Principal threats and controls

| Threat | Required control |
|---|---|
| LAN/public exposure | literal `127.0.0.1` Compose binding plus template and runtime inspection tests |
| Local cross-site request | bearer capability, exact Origin allowlist, strict preflight, Host validation |
| Upstream key disclosure | separate local/upstream credentials, stdin-seeded private named volume, redacted errors, no body logging |
| ChatGPT token repurposing in supported paths | official App Server lifecycle only; the adapter is Relmio-specific and exposes no `/v1` route; the private n8n bridge remains separately labeled unofficial/policy-uncertain |
| Private sidecar exposure | zero host publishers, one exact reviewed external network, fixed Docker DNS alias, and no reverse-proxy labels |
| Sidecar credential disclosure | server-side validation, stdin-only seed helper, private labeled volume, disabled seed logs, and redacted results |
| Assistant host exposure | exact owned service set, no host publishers or proxy labels, generated private aliases, and post-start inspection |
| Privileged runner compromise | explicit local-testing scope, owned internal network, immutable image pins, and Daytona recommendation for production |
| Command injection | validated scalar values, spawn argument arrays, no shell |
| Managed-path takeover | refuse unmanaged roots and every symlinked component |
| Streaming resource exhaustion | header/body/concurrency/time bounds and backpressure |
| Docker privilege compromise | document Docker control as a privileged local boundary; mount no Docker socket into services |
| Secret recovery from UI | show capabilities once; never use browser storage; rotate on reinstall |
| Codex capability compromise | explicit trust warning; target-specific least-privilege interfaces, private container volumes, no host mounts, and server-side-only adapter use |
| Model-induced credential read | root-deny model filesystem profile, minimal runtime read allowlist, explicit `/home/node/.codex` deny, empty private workspace, and no turn network access |

## Acceptance criteria

- The browser wizard visibly offers all three loopback contracts plus the local
  self-hosted n8n bridge and n8n AI Assistant tools; the legacy VPS path remains
  separate.
- Platform keys are accepted only by `openai-api`; both Codex targets use only
  official App Server-backed ChatGPT authentication.
- Loopback Compose files publish only literal `127.0.0.1` bindings; the n8n
  sidecar Compose file publishes no host port.
- Every non-health gateway operation that can reach OpenAI and every App Server
  WebSocket handshake is capability-authenticated; exact-origin CORS preflight
  is a non-forwarding metadata exception.
- Gateway unit/integration tests cover auth, origins, Host validation,
  streaming, cancellation, upstream errors, and secret redaction.
- Adapter tests cover auth, Origin rejection, request/protocol validation,
  process cleanup, bounds, concurrency, final-output selection, and redaction.
- Local installer tests prove confirmation, unmanaged-root refusal, symlink
  refusal, port collision behavior, exact Docker arguments, file modes, and
  absence of n8n lifecycle commands. Sidecar tests also prove exact
  network identity, alias-collision rejection, stdin-only OAuth seeding, zero
  host publishers, and ownership-attested removal.
- Server tests prove install serialization, lock release, and fresh-process
  Codex login only after persisted installation attestation.
- Codex login tests use a fake stdio App Server process and cover initialization,
  device-code response validation, completion, cancellation, malformed output,
  and bounded output.
- Existing remote tests remain green.
- Opera GX runtime QA verifies keyboard flow, responsive layout, clean console,
  no credential persistence, and correct mode-specific copy.
- Full `npm run check`, `npm audit --audit-level=high`, and
  `npm pack --dry-run` succeed before handoff.

## Out of scope

- Public, LAN, hosted, reverse-proxied, or multi-user endpoints; this includes
  exposing the n8n sidecar through ngrok or a host port
- Translating Codex turns into `/v1/chat/completions` or `/v1/responses`
- Sharing, pooling, reselling, or redistributing any ChatGPT account or benefit
- TLS termination (loopback-only transport is the boundary for this release)
- Automatic migration or modification of the existing VPS/n8n deployment
- A production-support promise for experimental Codex WebSocket transport
