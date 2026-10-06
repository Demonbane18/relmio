# Local endpoint implementation contract

This document describes the current local/self-hosted SIWC implementation, not
provider approval or live account, model, Windows, Docker, n8n, or VPS acceptance.
See the [2026-10-05 source check](openai-source-check-2026-10-05.md) for the
official source register, data handling, and open questions.

## Scope

Relmio's local open-source flow follows OpenAI's documented Sign in with
ChatGPT (SIWC) registration and plan-use flow. It needs no commercial approval,
partner-issued client ID, or client secret. The user still signs in through
OpenAI and separately grants ChatGPT plan use. Identity verification, plan
permission, account eligibility, model access/admission, and a completed
request are distinct checks.

The public website's `/api/chat` remains `410 Gone`. It is separate from the
local open-source flow and remains off pending distinct hosted-access work.
This specification does not describe or implement hosted chat.

## Local targets

| Target | Interface | Authentication boundary |
| --- | --- | --- |
| `codex-chatgpt` | Loopback WebSocket relay to the official Codex App Server over stdio | Selected SIWC registration and a high-trust local bearer for a trusted native client |
| `codex-chat` | Relmio-specific `POST /chat` with bounded JSON or event-stream output | Selected SIWC registration and a separate bearer for a trusted local backend; read-only turn |
| `n8n-openai-oauth` | Private OpenAI-compatible `/v1/models`, `/v1/responses`, and a `/v1/chat/completions` compatibility route with bounded function tools on the selected n8n network | Selected SIWC registration in the sidecar and a one-time Relmio bearer entered manually in n8n |
| Other local services | SuperGrok, local-model, Assistant, and new-n8n routes documented separately | These do not share or inherit an SIWC registration; see [local endpoints](local-endpoints.md) |

The two Codex targets are local protocols, not general OpenAI `/v1` endpoints.
The Chat Adapter does not expose App Server WebSocket or read/write tools. The
raw App Server target is high trust even though the relay is loopback-bound and
requires its local bearer. The relay forwards every client JSON-RPC call except
a short deny-list to the official App Server, which runs as the same user that
owns the SIWC store. Connect only trusted local clients.

## Registration and plan use

- New SIWC registration uses Relmio's own app identity, a stable host ID, and
  OpenAI's dynamic registration. No personal `~/.codex` credential is imported.
- Relmio stores the issued client ID in a protected pending record before
  exchanging the authorization code. A failed or cancelled exchange does not
  create a verified, selectable account; retry uses the pending registration.
- The callback is bound to loopback, state, PKCE, nonce, issued client ID, and
  verified issuer/client/subject. Email is a display label, not the account key.
  An optional `scope` is accepted and ignored; an optional `iss` must equal the
  discovered issuer. A valid-state `access_denied` makes no token request and
  reports a declined sign-in or declined plan use without changing an existing
  verified registration. A request with the wrong state is rejected without
  cancelling the sign-in in progress.
- The returned token scopes, not requested scopes, determine whether
  `chatgpt.tokens.use.direct` was granted. Identity-only registrations remain
  connected but cannot make plan requests.
- Plan use requires the separate ChatGPT grant and the first-use confirmation
  for that registration. n8n background workflows require an additional,
  explicit background-use consent.
- The selected registration's protected record holds identity, issued client,
  granted scopes, tokens, plan state, and host/runtime ownership. Browser account
  responses contain safe metadata, never access, refresh, or ID tokens.
- Refresh is serialized under a per-account lock. The owner record binds the
  holder process, its PID namespace, and on Linux the boot ID. A lock from an
  earlier boot is reclaimed at once; one held from another container or PID
  namespace on the same boot is reclaimed only after a 10-minute lease. A
  holder stops without further writes after its 2-minute operation deadline.
  A waiting caller retries for up to 2.5 minutes, then gets HTTP `503`
  `siwc_lock_unavailable` with recovery `retry-later`. A discovery failure
  before the refresh POST leaves the session unchanged. Before sending a
  refresh POST, Relmio persists a frozen state and disables plan use. A
  token-endpoint `503` with
  `temporarily_unavailable` restores the pre-refresh session and reports
  retry-later; this assumes no rotation occurred, which OpenAI does not
  document. Any other response or an ambiguous network result leaves token
  bytes protected but unusable. Never retry the possibly rotated refresh token;
  a fresh SIWC sign-in is required. A successful replacement token is stored
  frozen until ID-token verification completes. Terminal `invalid_grant` clears
  unusable token state. Sign-out clears local tokens; frozen refresh state
  remains revocation-unconfirmed even when OpenAI returns HTTP 200. Local
  deletion alone is not provider revocation.

## n8n sidecar

The sidecar accepts a Relmio bearer and forwards only `GET /v1/models`,
`POST /v1/responses`, and a compatibility `POST /v1/chat/completions` route,
plus `POST /v1/images/generations` and `/v1/images/edits` when the VPS image
add-on is on.
Responses requests are bound to the selected registration and public
`api.openai.com/v1/responses`; only a completed provider response is success.
Streamed Responses events pass through unchanged. When OpenAI's final event
has an empty `output`, non-streaming and Chat responses are rebuilt from the
`response.output_item.done` events. The sidecar's catalog `client_version`
uses the newest stable Codex release from npm, checked about every 12 hours, with
Relmio's pin (0.160.0) as the floor. This sends no credentials to
`registry.npmjs.org`, which sees the server's IP address. The catalog cache
lasts 5 minutes. OpenAI's version filter is undocumented and could change.
The wizard's pre-install picker and local Codex gateways keep the pinned
version. Local n8n sidecars have checks off by default and no check controls;
completed traffic and model-level failures still update their model records.
See [discovery rules](n8n-configuration.md#model-discovery-and-checks).

The compatibility route accepts text user, assistant, and developer messages,
assistant tool calls, and matching tool results. Function tools go upstream in
one developer `additional_tools` input item; n8n executes them, not the
gateway. Limits are 32 tool calls, 128 KiB of arguments per call, and 2 MiB of
streamed arguments in total. A named `tool_choice`, tool namespaces, custom
tools in streamed requests, and system messages are rejected. Chat clients
receive only final-answer text; reasoning items and `commentary` text are not
passed on. On 2026-10-05 a two-turn LangChain tool test passed through the
real gateway on one ChatGPT account, streaming over both routes; other
accounts, models, and non-streaming tool calls were not tested live.

Unsupported request fields and tool types, background requests, stored response
or conversation IDs, audio/video, audio endpoints, Files management,
Moderations, Live/Realtime, Video, and other unimplemented routes are rejected,
not forwarded. The image routes answer only through the opt-in VPS image
add-on, which uses a separate Codex sign-in; a local sidecar has no image
sign-in and returns `images_off`. Model listing is not proof of entitlement
or admission. Errors do not switch registrations or fall back to Platform API
billing. `store:false` is not a zero-retention promise.

The n8n bearer identifies that private sidecar, not the OpenAI account. It is
generated locally, displayed once, and stored only as a verifier in Compose;
the owner enters it in n8n. The sidecar joins only the reviewed existing n8n
network, publishes no host port, and does not edit n8n's configuration,
credentials, image, or lifecycle.

## Codex App Server

The local WebSocket relay starts the official App Server over stdio with the
selected SIWC access token in `ACCESS_TOKEN`, a public Responses provider, and
`supports_websockets=false`. It is not a web app, general OpenAI gateway, or
OS sandbox. Requests are tied to the selected identity and model catalog; the
relay does not switch accounts.

The generated configuration disables agent spawning and sets native request
and stream retries to zero. The RPC gate rejects deferred/dynamic `tool_search`,
hosted connector/MCP OAuth, account/auth RPCs, marketplace/plugin/configuration
mutations, per-thread provider/model/fallback overrides, and path/history/
rollout selectors on thread resume/fork. Inline function/custom tools and local
direct tools remain within the high-trust boundary; this is not full App Server,
MCP, or agent feature parity. A trusted same-UID tool can inspect its own
process environment or files.

The relay records successful thread starts/forks in a protected,
registration- and runtime-bound registry before forwarding their IDs. A
restart can resume a known thread only for the same verified
issuer/client/subject, model catalog, and child-returned thread ID. Unknown or
foreign IDs, thread selectors, and unavailable models are rejected. Access-token
expiry closes the socket shortly before expiry; a reconnect starts a new child,
and interrupted turns are never replayed.

## Installation, transfer, and policy boundary

Local Codex targets and n8n sidecars bind the selected registration, owner, and
runtime. n8n installs also bind the selected container and network; they
re-attest those resources and require reviewed confirmation before installation.
n8n remains operator-owned and unchanged.

Credential-copy legacy targets are never silently adopted. A local migration
requires a fresh SIWC registration, separate migration consent, and final
confirmation of the attested old target. Relmio stops only that owned service,
keeps its old credential/workspace volumes offline, and creates a separate
SIWC runtime. Tokens and history are not merged; uncertain migrations remain
stopped and preserved for inspection.

A VPS destination has its own host ID. The source is frozen before the
protected transfer; the destination becomes the refresh owner only after a
matching receipt. Unknown transfer outcomes remain frozen. SSH host-fingerprint
verification happens before authentication, and a separate confirmation is
required before remote writes. The reviewed n8n container and network IDs are
re-attested before the first write and before the transfer; a changed ID
requires a new review. After a VPS install completes, Relmio binds only the SSH
host identity and the Docker network ID, so status and sign-out keep working
if n8n is recreated or the SSH login method changes.

An interrupted local or VPS install is reported as `staged` and can be resumed
after a review that names the selected account, without deleting data or
creating a second refresh writer. A same-account resume uses the account's
current generation, so plan toggles or token refreshes do not block it. A lost
acceptance acknowledgment is reconciled from the destination's receipt; with
no receipt the sender stays frozen and needs a fresh sign-in. A fresh account
can resume only after a confirmed not-accepted result, and is refused if the
original receipt appears or, on a VPS, while a one-off helper container is
still present. A finalization failure after transfer still shows the one-time
key once, with a warning not to use it until resolved. Relmio never restarts
an old writer automatically. VPS file publication is atomic and confined to
`/docker/n8n-openai-oauth`, and every SSH command has a finite deadline.

OpenAI's self-hosted VM guide and SIWC Terms do not resolve persistent remote
VPS token storage. These implementation safeguards do not settle that
question; this specification makes no provider-approval claim for VPS
transfer/storage. See [VPS and n8n](vps-and-n8n.md) and the
[source check](openai-source-check-2026-10-05.md).

## Other documented security boundaries

- Local endpoints bind to loopback; private n8n companions publish no host port
  and reject browser-origin requests where implemented.
- Managed paths reject symlinks/unmanaged ownership. Docker calls use bounded,
  allowlisted operations against the selected daemon and owned resources.
- Provider tokens, bearer values, prompts, and raw child output are not
  deliberately returned in wizard account responses. Runtime, Docker, SSH,
  workflow, browser, provider, and host logs are not all controlled by Relmio.
- See [security.md](security.md), [local-endpoints.md](local-endpoints.md),
  [n8n configuration](n8n-configuration.md), and
  [troubleshooting](troubleshooting.md) for operational instructions and
  recovery boundaries.
