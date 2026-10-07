# Relmio local SIWC setup specification

This specification describes the current source implementation of the local
ChatGPT plan-use flow, its local Codex clients, and its self-hosted n8n
sidecar. It is not provider approval, a legal opinion, or evidence of a live
account, Windows, Docker, n8n, or VPS acceptance. See
[the 2026-10-05 source check](docs/openai-source-check-2026-10-05.md) for official
sources, data handling, unresolved requirements, and historical reviews.

## Product boundary

Relmio uses OpenAI's documented open-source Sign in with ChatGPT (SIWC) flow
for local plan use. It keeps these checks separate:

1. Verify the user's identity and returned registration.
2. Verify that the token response granted `chatgpt.tokens.use.direct`.
3. Enable plan use for the selected registration, then obtain an account-specific
   model catalog and a completed Responses request.

An identity-only result remains connected but cannot use ChatGPT plan models.
A requested scope, local install confirmation, model listing, container health,
or successful login is not a grant, account-entitlement check, host-admission
result, or completed inference. Relmio never merges registrations by email,
imports `~/.codex`, rotates to another account after an error, or falls back to
OpenAI Platform API billing.

The public website's `/api/chat` remains disabled with `410 Gone`. That route
is separate from this local open-source flow and remains off pending distinct
hosted-access work. The documented local SIWC path needs no commercial approval,
partner-issued client ID, or client secret. The separate SIWC plan grant is
still required. Persistent remote VPS token storage remains unresolved by the
published VM guide and Terms; this specification makes no provider-approval
claim for VPS transfer/storage.

## Runtime and protected state

- Node.js 24 or newer; ECMAScript modules and the built-in HTTP server.
- `jose` 6.2.12 validates OpenAI ID tokens and JWKS signatures.
- `ws` 8.22.0 relays the local WebSocket App Server protocol.
- `ssh2` 1.17.0 handles the verified SSH boundary.
- The first foreground wizard run works without a `.relmio` directory or a
  local n8n stack. A selected workflow reports missing prerequisites in the
  browser.
- `N8N_OPENAI_OAUTH_HOME` selects the protected SIWC storage root; otherwise
  the root is `~/.n8n-openai-oauth`. Each account has a separate registration
  record. POSIX files/directories use owner-only permissions; Windows uses the
  existing current-account ACL verification. Symlinks, insecure ownership, and
  unmanaged destinations fail closed.
- The same root holds `ui-preferences.json`, which records only whether the
  setup guide is on or off. `GET /api/ui/preferences` reads it without
  following a symbolic link to the file and only as a regular file of at most
  1 KiB. `POST /api/ui/preferences` accepts exactly `{"guide":"on"}` or
  `{"guide":"off"}`. Saving creates a missing root (never its parents) with
  mode `0700`. On POSIX hosts the file is then written with mode `0600` only
  when the root is a non-symlink directory owned by the current user with no
  group or other permission bits; otherwise the write is skipped. Windows
  skips that ownership and mode check.
- The persistent host ID belongs to each actual installation. A transferred
  registration binds to the destination host/runtime and is not refreshed by
  the sender after ownership transfer.
- Safe browser views contain registration ID, label/optional email, verified
  identity state, session state, plan grant/enabled state, ownership, generation,
  owner IDs, and first-use status. They do not contain provider tokens, client
  secrets, filesystem paths, or authorization URLs.

Registrations are keyed by verified issuer, issued client ID, and subject.
Sign-in launches the system browser after binding a loopback callback to
`127.0.0.1`. A single-use state/PKCE/nonce transaction checks the issued client
ID and verifies the ID token against OpenAI discovery/JWKS, issuer, audience,
nonce, and the existing subject during reauthorization. A request with the
wrong state is rejected without cancelling the sign-in in progress. The
callback accepts and ignores an optional `scope`; plan permission comes only
from the token
response. An optional `iss` must equal the discovered issuer. Any other or
duplicate parameter fails before the code exchange. A valid-state
`error=access_denied` makes no token request and reports a declined sign-in
or declined plan use; a declined plan request leaves the verified
registration unchanged. The `dynamic_agent_client` bootstrap ID is not stored
as the issued registration. Relmio does not store provider passwords or
browser cookies.

Granted scopes come from the token response. Refresh runs under a per-account
lock and verifies refreshed identity before issuing a lease. The lock owner
record binds the holder process, its PID namespace, and on Linux the boot ID.
A lock from an earlier boot is reclaimed at once. A lock held by a process in
another container or PID namespace on the same boot is reclaimed only after a
10-minute lease. In the same namespace, a lock is reclaimed when its process
has exited or its PID now belongs to another process. A holder stops without
further writes once its 2-minute operation deadline passes and returns HTTP
`503` `siwc_lock_deadline`. A waiting caller retries for up to 2.5 minutes,
then gets HTTP `503` `siwc_lock_unavailable` with recovery `retry-later`.
Lock records are written complete, fsynced, and published with an exclusive
hard link, so a crash cannot leave a half-written lock. Release also waits up
to 2.5 minutes through short contention. Once a refresh POST starts, a
caller disconnect does not cancel it, and the rotated token is still saved.
The SIWC store (`N8N_OPENAI_OAUTH_HOME` or the sidecar volume) must stay on a
local disk used by one kernel. Do not sync it or place it on a network share.

If OpenAI discovery fails before a refresh request is sent, the session
remains unchanged. Before a refresh POST, Relmio persists `refreshUncertain`
and disables plan use. An HTTP
`503` with `temporarily_unavailable` restores the pre-refresh session and
reports retry-later. This assumes OpenAI did not rotate the refresh token;
OpenAI does not document that guarantee. Another response error or an
ambiguous outcome leaves retained token bytes protected but frozen; the old
refresh token is never retried. A successful
replacement is stored frozen until its ID token is verified. Terminal
`invalid_grant` clears unusable token state. A fresh SIWC sign-in is required
to use a registration frozen by refresh uncertainty. Requests never switch
accounts.

Sign-out attempts revocation at the endpoint returned by OpenAI discovery and
clears local tokens while retaining the registration identity/label mapping.
The result reports `confirmed`, `unconfirmed`, or `not-applicable`. A
refresh-uncertain registration remains unconfirmed even if token revocation
returns HTTP 200, because the token family may have rotated beyond the
retained record. An unconfirmed result is not remote revocation or provider-side
deletion; use ChatGPT's disconnection controls.

## Wizard account and consent behavior

The wizard lists saved registrations and allows explicit selection. It supports
new-account sign-in and reauthorization for a selected account. **Allow ChatGPT
plan use** starts a separate ChatGPT authorization; a local preference never
creates provider permission. A first-use confirmation is persisted for the
selected registration and required before plan model use. The UI links to
ChatGPT **Manage usage** at `https://chatgpt.com/settings/usage` on plan-use
states and usage-limit recovery.

Every wizard page loads an optional setup guide. The first visit asks whether
to start it, and the saved choice applies after that. Its static tips point at
page elements and never fill a field. When the page shows an error, the guide
maps the error's flags, code, recovery, or HTTP status to next steps and a
control to point at; with the guide off, one button offers the same help.

**Plan and usage** shows the installed n8n sidecar's own request counts for
the last 30 UTC days, the account and plan-use state, model counts, and the
last plan-usage event with its recovery. It shows no plan percent, reset time,
or credits and links to **Manage usage** for them. On a VPS,
`POST /api/siwc/vps/usage/status` accepts exactly `containerName`,
`networkName`, and `registrationId`. It needs a direct-root session and a
**Check installed account** review from the last five minutes, allows 10
reads per 15 minutes, and runs only the static allowlisted `usage` command on
the running owned sidecar. On this computer, `GET /api/local/usage/status`
runs the same command through `docker compose exec` after ownership
attestation; sanitized preview reads nothing.

n8n installation requires a separate, explicit approval for background
workflow use plus confirmation of the reviewed installation. Neither approval
substitutes for the other. For VPS writes, Relmio verifies the SSH host key
before authentication and requires a final human confirmation after showing the
verified server identity and exact plan. If SSH connects but the read-only
Docker or n8n discovery fails, the wizard keeps the verified connection and
offers **Retry discovery** without asking for the password again. Changing the
host, port, username, or authentication method requires a fresh identity
check.

## Local public APIs

### OpenAI-compatible n8n sidecar

The sidecar requires a generated Relmio bearer and serves:

- `GET /health` for liveness.
- `GET /v1/models` for the selected account's text models, filtered to
  `visibility == "list"` and `supported_in_api` not `false`, without IDs that
  contain `image`, in provider order with display names and slugs (at most
  256). The catalog's `client_version` is the newest stable
  `@openai/codex` version from `registry.npmjs.org`, checked about every 12
  hours with no credentials, and never below `CODEX_CLI_VERSION` (0.160.0).
  OpenAI filters the catalog by this parameter but does not document it. The
  catalog is cached for 5 minutes. When a refresh fails, a list up to 1 hour
  old is served, except after an upstream 401; otherwise the route returns
  `catalog_unavailable` (401 `reauthorize` or 503 `retry-later`). Token lease
  failures keep the `registration_unavailable` mapping. Models that fail with
  a model-level error are hidden for 24 hours. Optional per-install model
  checks (VPS, off by default, consent recorded) list only models that
  answered a short test once any has. See
  [model discovery](docs/n8n-configuration.md#model-discovery-and-checks).
- `POST /v1/responses` for validated Responses requests. `max_output_tokens`
  is dropped before validation: SIWC lists it as unsupported, so no cap can
  be honored. Upstream requests set `store:false` and `stream:true`. When the
  client sets `reasoning`, `reasoning.encrypted_content` is added to its valid
  `include` values; otherwise `include` is sent as the client wrote it. Only
  `response.completed` is success. Streamed events, including any `phase`,
  pass through unchanged, with two exceptions. A stream error the sidecar adds
  is an `error` event with `type: "error"`, `sequence_number`, `code`,
  `message`, and `param: null`. Rewritten `response.failed` and
  `response.incomplete` events keep the upstream `sequence_number` (or the
  next number), a redacted `incomplete_details.reason`, and `usage`. Usage is
  passed on only when its input and output token counts are whole numbers,
  keeps only whole-number counts, and is left out of an incomplete event
  without a reason.
  OpenAI's final `response.completed` event can carry an empty `output`; for
  non-streaming requests and Chat translation, Relmio rebuilds the output from
  the `response.output_item.done` events.
- `POST /v1/chat/completions` as a compatibility route translated into a
  Responses request. It accepts `model`, `messages`, `tools`, `tool_choice`
  (`auto`, `none`, or `required`), `parallel_tool_calls`, `stream`,
  `stream_options.include_usage` with streaming, and `reasoning_effort`
  (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), which is
  sent as `reasoning.effort`. `max_completion_tokens` and `max_tokens` are
  accepted and dropped. Messages are text `user`, `assistant`, or `developer`
  messages, assistant `tool_calls`, and matching `tool` results; every call
  needs exactly one result. Function and custom tools are sent upstream in
  one developer `additional_tools` input item, with omitted function
  `parameters` and `strict` sent as `null`. Limits are 128 tools, 32 tool
  calls per message or response, 128 KiB of arguments per call, and 2 MiB of
  streamed arguments in total. A named `tool_choice`, tool namespaces, custom
  tools in streamed requests, system messages, and other fields it cannot
  preserve are rejected. Reasoning output items are skipped. Only message
  text with phase `final_answer`, or no phase, reaches Chat Completions
  clients; `commentary` text is dropped. Stream errors keep the Chat
  Completions error body. The gateway never executes tools.
- `POST /v1/images/generations` and `POST /v1/images/edits`, only when the
  opt-in VPS image add-on is signed in; otherwise `404 images_off`. The add-on
  uses a separate Codex device sign-in (Codex CLI client ID), stores its tokens
  under `<storage root>/codex-images/` on the VPS, and calls
  `https://chatgpt.com/backend-api/codex/images/{generations,edits}`. OpenAI
  does not document that route for other apps, so it can stop working, and
  images count against the plan's Codex limits. Only `gpt-image-2`, one image,
  base64 output, no mask, and sizes `1024x1024`, `1024x1536`, `1536x1024` or
  `auto` are accepted; edits take 1 to 16 PNG, JPEG, WebP or GIF images of up
  to 25 MiB each within a 48 MiB body. `GET /v1/models` adds `gpt-image-2`
  while the add-on is signed in, except for requests with n8n's
  `openai-platform` header (Chat Model node and Chat Hub). The local sidecar
  has no image sign-in.

Item references are resolved from memory. From each `/v1/responses` request,
streamed or not, that reaches `response.completed`, the sidecar keeps
reasoning items that carry `encrypted_content` (type, ID, encrypted content,
and summary) and assistant messages made only of `output_text` parts (text,
plus `phase` when it is `commentary` or `final_answer`), keyed by item IDs
that match `^[A-Za-z0-9_-]{1,128}$`. Before validation, each `item_reference`
input item with a kept ID becomes a copy of that item, and references to
unknown IDs are dropped. An invalid ID, or input left empty, fails with 400
`param: input`; copies above 2 MiB in one request fail with 413
`body_too_large`. The memory is per process and never written to disk. It
holds at most 4,096 items and 32 MiB of JSON, expires an item 6 hours after
it is stored, evicts the least recently used item first, and is lost on
restart. Failed, incomplete, or interrupted responses add nothing, and Chat
Completions requests neither fill nor use it.

Each text request the sidecar sends to OpenAI on `/v1/responses` or
`/v1/chat/completions` is counted once per UTC day and model, with its
outcome (completed, failed, incomplete, or none when the client leaves or
cancels) and, for completed responses, the token counts from
`response.completed.usage`. A model ID is kept only for a completed or
incomplete request or an ID in the last loaded catalog; anything else counts
as `other`. The last plan-usage error code is kept until a completed response.
Counting is synchronous, in memory, and never delays or changes a response.
The record, `<storage root>/activity/<registrationId>.json`, is written at
most every 30 seconds and on close, with the model-check store's safety
checks. Each write keeps the 31 most recent UTC days and at most 64 named
models per day; nothing else deletes it. It holds no prompts, outputs, request
IDs, IP addresses, or headers. See
[request counts](docs/security.md#request-counts).

All text inference requests use the selected SIWC registration and public
`https://api.openai.com/v1/responses`; the SIWC token is never sent to the
image route. Errors preserve safe status, code, parameter, request ID,
redacted upstream detail/error shape, and recovery. A
post-delta error, incomplete response, or interrupted stream is not reported
as a completed answer. Requests do not fall back to a different account,
provider, API key, or host.

Unsupported Responses fields (except `max_output_tokens`, which is dropped),
`background:true`, `store:true`, stored response/conversation identifiers,
system messages, audio/video inputs, and unsupported tool types, including
`image_generation`, are rejected. Audio and transcription, video, Files API
management, stored responses/conversations, moderation, Live, and Realtime
routes are not forwarded. Image/file input in a Responses request is usable
only when supported by the selected model; this
never enables the Files API. Flat function and custom tools in a Responses
request are moved into the same `additional_tools` item. A `tools` list,
`additional_tools` item, or namespace holds at most 128 tools. Tool use remains
conditional on the exact accepted Responses input, model, account, and
workspace policy. On 2026-10-05 a two-turn LangChain function-tool test
passed through the real gateway on one ChatGPT account, streaming over both
the Chat Completions and Responses routes. Other accounts, models, and
non-streaming tool calls were not tested live.

For n8n, the result screen returns a private base URL and a one-time Relmio
bearer. The owner enters both manually in n8n; the bearer is not an OpenAI key.
Compose stores its verifier, not the bearer. The sidecar joins only the
selected Docker network, publishes no host port, and does not edit n8n's
credentials or Compose configuration.

### Codex App Server relay

`ws://127.0.0.1:<port>` retains the local Codex App Server JSON-RPC protocol and
requires a local Relmio bearer. A `ws` relay connects to the official App Server
child over stdio. The child uses the selected SIWC access token as `ACCESS_TOKEN`
and a public Responses provider; there is no Codex device-code sign-in. The
raw route is high trust for a trusted native client owned by the same person,
not for browser JavaScript or public/hosted use. The relay forwards every
client JSON-RPC call except a short deny-list to the official App Server,
which runs as the same user that owns the SIWC store. Connect only trusted
local clients. After install, Relmio checks the selected account's live model
catalog inside the running container with `docker compose exec`, not in a
one-off helper container.

The token lease is not renewed inside an open socket. A protected registration-
and runtime-bound registry records successful `thread/start` and `thread/fork`
IDs before returning them. After expiry or relay restart, reconnect and
explicitly resume a known thread for the same verified identity; unknown or
foreign IDs, or a model outside that registration's catalog, are rejected.
Interrupted turns are never replayed.

The generated configuration disables agent spawning and sets native request
and stream retries to zero. The RPC boundary rejects deferred tool search
(`tool_search`), hosted connector/MCP OAuth, account/auth RPCs,
marketplace/plugin/configuration mutations, per-thread provider/model/fallback
overrides, and path/history/rollout selectors on thread resume/fork. Supported
inline function/custom tools and local direct tools remain inside the
high-trust boundary; this is not full App Server, MCP, or agent feature parity.
A trusted same-UID tool can inspect its own process environment or files.

### Codex Chat Adapter

The local HTTP `POST /chat` adapter has its own one-time Relmio bearer. It uses
the selected SIWC registration to run a bounded read-only conversational turn
with a narrow permission profile and an account-bound conversation ID. It
rejects browser `Origin` headers. It is not `/v1/chat/completions`,
`/v1/responses`, a hosted API, or the raw App Server capability.

## Local n8n / VPS ownership and migration

The sidecar installer requires an existing running n8n container and a selected
shared Docker network. It adds a separate Relmio-owned Compose project and
makes no changes to n8n's Compose project, image, container, or lifecycle. The
one-time local bearer is entered by the n8n owner.

For a VPS, the existing administrative prerequisites remain: a verified SSH
host fingerprint before authentication, approved direct-root access for
credential-bearing operations, rootful Docker/Compose/Buildx on the verified
local daemon, safe pre-existing `/docker`, and a running eligible n8n container
on a selected network. The wizard confirms the exact remote identity and plan
before a write. Local model-only passwordless sudo does not authorize SIWC
bridge operations.

The installer initializes the destination host ID before transfer. It checks
the registration/client/generation/owner binding, freezes the source before
sending bounded protected bytes through stdin, requires a destination
attestation receipt, and only then clears sender tokens. An unknown result stays
frozen and fails closed. The destination becomes the sole refresh owner.
Installed sign-out or plan-disable stops and attests the exact managed service
before changing its local registration.

The review binds the immutable IDs of the selected n8n container and Docker
network. The VPS installer re-attests both IDs before its first deployment
write and again before the credential transfer. An interrupted install keeps
the full reviewed target binding: SSH identity, login method, container, and
network. A completed install binds only the SSH host identity (host, port, and
fingerprint) and the Docker network ID, so status and sign-out keep working
after n8n is recreated or the SSH login method changes. A changed network ID
is still refused. Local n8n installs record the same identities in their
ownership marker.

An interrupted install records a staged checkpoint, and status reports
`staged`. A resume review requires the selected account. A reviewed,
confirmed resume continues the same installation without deleting data or
creating a second refresh writer. A same-account resume uses the account's
current generation, so a plan toggle or token refresh before resuming does
not block it. Resuming after a completed transfer replaces the one-time client
key. If the destination committed the session but the sender lost the
acknowledgment, a reviewed reconcile reads the destination's identity-bound
receipt and finishes the sender. With no receipt, the sender stays frozen and
needs a fresh sign-in; old tokens are never restored. Transport uncertainty
reports an unknown remote outcome. A fresh account may resume only after a
confirmed not-accepted result. Relmio rechecks that the original receipt is
still absent, and on a VPS refuses while any one-off sidecar helper container
is still present.

If ownership transfers but a later finalization step fails, the result is
`partial` with a `finalizationFailure`. It still delivers the one-time key
once, with a warning not to use it until the reported issue is resolved.

VPS publication of managed files uses an exclusive temporary file and an
atomic rename confined to `/docker/n8n-openai-oauth`. It rejects symlinked,
non-root-owned, or group/other-writable ancestors and symlinked, non-regular,
or hard-linked targets, and never truncates an existing file. Every SSH
command has a finite deadline: 45 minutes by default, 30 minutes for an image
build, 2 minutes for handoff acceptance, and 5 minutes for a file
publication. A deadline closes the command channel and reports an unknown
remote outcome without an automatic retry.

Legacy credential-copy targets are never silently adopted or imported. A local
migration requires a fresh SIWC registration, separate migration consent, and
final confirmation of the exact target. Relmio stops only the attested old
service, preserves its credential/workspace volumes offline, and creates a
new SIWC runtime. No old token or history is merged; uncertain local migrations
remain stopped for inspection without automatic restart, rollback, or deletion.

The reviewed VPS migration likewise marks the destination pending, archives
the old generated Docker files, stops the exact old sidecar, and leaves the
legacy `/auth/auth.json` credential offline. The new runtime uses
`/docker/n8n-openai-oauth/siwc`; a receipt is required before the VM becomes the
sole refresh owner. If transfer is uncertain, retain the pending marker and old
data; do not automatically restart the old service or delete either runtime.
The VPS token-storage Terms issue remains unresolved, and these controls do
not establish provider approval.

## Public website route (outside this specification)

The website's `/api/chat` returns `410 Gone` with `Cache-Control: no-store`;
it does not read request bodies or call a provider. This local specification
does not implement plan-funded website chat. See the
[source check](docs/openai-source-check-2026-10-05.md) for the recorded hosted
route status and the distinct local OSS SIWC evidence.

## Acceptance boundaries

The source implementation is not evidence that a live OpenAI account can
connect, receive the needed grant, list entitled models, reach an admitted host,
or complete inference. The live checks recorded in the
[2026-10-05 source check](docs/openai-source-check-2026-10-05.md) cover one
account on macOS with a local store. Native Windows ACL/runtime acceptance,
real Docker/n8n installation, real VPS transfer, refresh after expiry, provider
revocation, usage limits, and browser interaction must be reported only when
separately exercised. Fake-provider fixtures do not prove live provider
capability, permission, policy, or Terms compliance.
