# SuperGrok OAuth beside n8n

## Status

Replacement Task 19, under development. The user requires SuperGrok through
Relmio for local apps and n8n AI Assistant, like the existing OpenAI OAuth
sidecar if the official provider interfaces support it. The previous API-key sidecar is retired.
No xAI API key may be requested, stored, or used as a fallback.

The selected route uses fresh official `grok login --device-auth` inside a new
Relmio-owned private volume and the provider-documented direct HTTP endpoint.
It reads only that runtime's marked session, with no host credential discovery,
token import, bespoke OAuth registration, or client-ID reuse.

On 2026-09-05 the live direct route passed fresh login, Chat Completions tool
calls, independent tool-result consumption, and stream cancellation followed
by a successful request. Actual disposable n8n 2.36.8 Instance AI also passed:
explicit `grok-4.6` called the node catalog, received the matching tool result,
and named an unpredictable draft workflow that was absent from the prompt. A
separate AI Agent Calculator workflow returned `9193` for `317 × 29`.
The individual draft deletion did not succeed; removal of the attested
owned n8n container and volume completed cleanup instead. Existing n8n was
unchanged. The signed-in SuperGrok test runtime is retained.

The normal private installer and dashboard flow are implemented and passed
disposable install/status/private-route/removal acceptance. Choose the candidate
connection **SuperGrok for n8n** and use `relmio grok login --n8n` after installation.
Actual operator-owned n8n configuration, explicit live logout/refusal, the full
Opera GX matrix, native Windows and protected release gates remain open. The
original OpenAI Assistant was restored after the test. See [the route
decision](supergrok-oauth-route-decision.md) for the pinned provider contract,
fresh-model discovery, and detailed evidence. The ACP sections below are
historical designs, superseded by the direct route; their MCP bridge is not part
of the selected implementation.

## OpenCodex comparison

Reference: OpenCodex v2.42.0, commit
`48f8186647d9ffb108d226dcfa91a64225aae2a7`, examined as public source only.
Its [xAI OAuth implementation](https://github.com/lidge-jun/opencodex/blob/48f8186647d9ffb108d226dcfa91a64225aae2a7/src/oauth/xai.ts)
uses direct OIDC/PKCE authentication, token storage and refresh, including an
optional import of Grok's saved tokens. Its
[transport](https://github.com/lidge-jun/opencodex/blob/48f8186647d9ffb108d226dcfa91a64225aae2a7/src/providers/xai-transport.ts)
calls `https://cli-chat-proxy.grok.com/v1` for subscription OAuth. It does not
use the official CLI through ACP. Source functionality is not evidence of
provider-documented third-party authorization for that endpoint/client.

The useful reusable portion is its
[Chat tool translation](https://github.com/lidge-jun/opencodex/blob/48f8186647d9ffb108d226dcfa91a64225aae2a7/src/chat/outbound.ts):
keep call IDs stable, pair each result exactly, and emit complete arguments once.
n8n does not require a fundamentally different external model protocol.
Relmio now uses that same HTTP tool/result pattern with fresh official CLI
sign-in and its own private session. The earlier ACP-to-MCP bridge is no
longer required.
Its account import, API-key fallback and quota failover are excluded.

The public [OIDC discovery document](https://auth.x.ai/.well-known/openid-configuration)
was checked on 2026-09-05 and confirms code/device/refresh grants, S256,
public-client token authentication and the Grok CLI/API scopes. It does not
advertise a registration endpoint. These capabilities do not establish a
supported registration or subscription-inference contract for a new Relmio
client. The selected official-login route avoids that registration question.

ACP is bidirectional: incoming `id` plus `method` denotes an agent request,
not a response to the client's request with the same ID. Follow the
[ACP permission contract](https://agentclientprotocol.com/protocol/v1/tool-calls)
and answer with the matching ID. Permission requests never authorize themselves;
the current disposable policy remains `dontAsk`, and an unexpected permission
request fails with a fixed diagnostic after a cancelled response. Unknown
extension requests receive method-not-found and can use their own fallback.
The [official SDK](https://agentclientprotocol.com/libraries/typescript) is the
reference for broader protocol compatibility; any replacement must retain
transport bounds, child reaping, and independent actual-tool success evidence.

## Earlier ACP provider boundary

The official pinned Grok Build CLI owns OAuth/device sign-in, refresh, logout,
and its isolated credential volume. Relmio invokes `grok agent stdio` and must
never inspect the credential store or reuse a token in an HTTP inference API.
The local bearer shown to a client authorizes only access to Relmio.

## Earlier ACP compatibility decision

The existing ACP adapter accepts text and returns text deltas. It creates a
fresh session, disables model tools, and does not expose agent-internal tool
updates as external function calls. A successful `/chat` response alone does
not establish n8n AI Assistant compatibility.

The isolated Chat Completions text prototype is an experiment only. Basic LLM
Chain success does not meet the user's Assistant requirement. The replacement
must preserve the Assistant's actual message, streaming, external tool-call,
and tool-result contracts. It must report only its actual configured model
and reject features it cannot support before provider activity.

Relmio's disposable n8n template pins version 2.36.8. Its upstream configuration
supports a custom model base URL, and its model factory uses Chat Completions
for that path. This source evidence does not establish the user's installed
version or a successful Assistant run. Any field named API key in n8n's custom
endpoint settings would contain only Relmio's local access bearer, never an
xAI API key or an extracted OAuth token.

At that earlier checkpoint, Assistant tool calling remained open. Grok's ACP tool progress events cannot
be relabeled as requests for n8n to execute them. Grok documents MCP servers
for external tools; whether a bounded MCP bridge can preserve Assistant tool
calls across model requests needs a separate feasibility test. Keep existing
provider tool restrictions in place until a reviewed implementation and live
evidence support any change. Do not claim that text-only ACP proves either
full Assistant compatibility or that a supported bridge is impossible.

## Earlier MCP bridge proposal

The ACP specification permits a client to supply a stdio MCP server when it
creates a session. Combined with Grok's documented MCP support, this permits
the following design. It is not yet verified against pinned Grok Build 1.0.13.

1. Accept the Assistant's message history and tool schemas. Start one ACP
   session with a trusted MCP command exposing only those tools.
2. When the MCP server receives an actual `tools/call`, validate its name and
   arguments. Keep that request pending and return a corresponding Chat
   Completions `tool_calls` response to n8n.
3. Let n8n execute its tool. Accept its next model request only if the local
   bearer, single-use call ID, model options, schemas, and full normalized
   transcript match the pending record. Reject altered history and replay.
4. Resolve the same pending MCP request with the bounded tool result. Keep the
   original Grok process, ACP session, and prompt alive until it emits another
   tool call or completes.

This would require a separate reviewed policy allowing only the exact bridge
tool namespace under `dontAsk`. The existing blanket MCP denial remains in
production. Client requests must never select executable commands, environment
variables, server URLs, or permission rules. Timeout, cancellation, malformed
continuations, and child failure must release the pending call and process.
Normal completion of the first HTTP tool-call response must preserve the
pending ACP turn; an abandoned continuation must expire within a bounded time.

The first live probe must discover one harmless nonce tool, hold its real MCP
call open, and prove that the same ACP prompt completes after the result is
returned. Separate probes must prove unrelated tools stay denied and pending
calls cancel cleanly. Offline transport tests cannot establish those provider
behaviors. Only after these pass should the full n8n model adapter be integrated.

The probe controller must generate the expected result only after the real tool
call is pending. Echoing a nonce already present in the prompt is insufficient.
It must observe the tool server's result acknowledgement, the original ACP
prompt's terminal response, and the independent result in the answer. Bounded assistant text before the tool result may be discarded, but must count
toward the output limit and cannot satisfy the result check. A terminal response
without the real tool call and independent result is a failure. The
cancellation probe must observe both ACP cancellation and closure of the held
MCP call. A timeout, early terminal response, duplicate call, or unreaped child
is a failed probe. Reports retain only booleans and fixed diagnostic categories.

The disposable live launcher and its policy remain separate requirements.
Grok documents that deny rules override allow rules; adding a narrow allow to
the production blanket MCP deny cannot enable the probe. Any replacement must
be confined to a fresh disposable image, preserve all other tool denies and
`dontAsk`, and prove the exact MCP name matcher and unrelated-tool denial on
the pinned CLI. The documented `<server>__<tool>` display name alone does not
prove which string a permission pattern matches. Do not loosen production
policy or enable all MCP tools to make the probe pass.

## Private installation

The companion must be separate from existing n8n and any ChatGPT OAuth bridge.
It joins one selected Docker network after exact container/network identity
attestation. It publishes no host port, including `10531`, and mounts no host
home directory or Docker socket. Its official OAuth runtime gets a fresh,
owned credential volume. Do not copy another application's login store.

Review the exact plan before local installation. Require final human
confirmation before any remote write. Never edit, exec into, stop, restart,
rebuild, recreate, or change the network membership of the existing n8n.
Cleanup must attest and target only the companion's owned resources.

## Acceptance

- Reject upstream API-key inputs and unsupported model request features before
  files, Docker, or provider activity.
- Test Host/Origin/bearer checks, body/output limits, streaming order,
  backpressure, cancellation, single-turn capacity, and generic error handling.
- Verify provider-owned sign-in and one real model request in a disposable
  installation without logging credentials or user content.
- Execute the actual n8n AI Assistant in disposable n8n. Verify its custom model
  configuration, streaming, conversation continuity, and a nonsecret tool call
  executed by n8n with the correlated result consumed by Grok. Basic LLM Chain
  and AI Agent node checks alone do not establish Assistant acceptance.
- Use separate nonsecret tool-policy canaries to test tool denial and override
  resistance. Canary non-disclosure alone does not prove credential isolation.
  The provider CLI shares its UID with the credential volume and has network
  access; release still requires a documented, enforceable provider or OS
  boundary for the cached-token non-disclosure requirement. Never read the real
  credential store to construct a canary test.
- Confirm logout causes the next request to fail without an API-key fallback.
- Verify Opera GX setup and one-time bearer handling. Preserve all release
  gates until live n8n compatibility and security evidence are complete.

The Assistant tool-result requirement above is now satisfied by the explicit
`grok-4.6` node-catalog run. Fresh private-installer acceptance has also
passed. The remaining work is logout/refusal, browser and native-platform
coverage, and protected release gates. A fresh `GET /v1/models` catalog is not
a substitute for tool proof.

## Sources

- [Grok Build subscription access and orchestration](https://x.ai/news/grok-build-cli)
- [Grok Build authentication and system policy](https://docs.x.ai/build/enterprise)
- [Grok Build ACP](https://docs.x.ai/build/cli/headless-scripting)
- [Grok Build MCP servers](https://docs.x.ai/build/features/mcp-servers)
- [ACP session setup and client-supplied MCP servers](https://agentclientprotocol.com/protocol/v1/session-setup)
- [n8n 2.36.8 Instance AI configuration](https://github.com/n8n-io/n8n/blob/n8n%402.36.8/packages/%40n8n/instance-ai/docs/configuration.md)
- [n8n 2.36.8 model factory](https://github.com/n8n-io/n8n/blob/n8n%402.36.8/packages/%40n8n/agents/src/runtime/model/model-factory.ts)
- [n8n OpenAI Chat Model](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/)
