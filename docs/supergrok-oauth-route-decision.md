# SuperGrok OAuth route decision

## Normal SuperGrok runtime integration verified, 2026-09-05

- The existing `xai-grok-build` installer now packages the direct OAuth runtime,
  Chat handler and fresh-session reader. Its normal image serves authenticated
  `/v1/chat/completions` and the existing simple `/chat` contract.
- Final generated image booted healthy, verified the local bearer and model
  list, rejected signed-out inference and browser origins, and reported the
  pinned Grok 1.0.13 binary. All three image source hashes matched the reviewed
  files. Only this image-test container, volume, network and image were removed.
- The normal runtime's `/chat` produced a live completed response inside the
  same signed-in disposable Grok runtime. Its temporary listener closed afterward;
  the preserved session and corrected private10532 handler remain available.
- Device login now uses owner-only file permissions and an in-container 15-minute
  bound. Interrupted Compose clients retain their lock when container cleanup
  cannot be proven, and cannot report a successful credential action.
- Fresh reviewer requested Sol/high, reported only GPT-6 identity (effort not
  exposed), under workspace-write with bounded repairs; no hard isolation claim.
  Review accepted the source integration after body-timeout/backpressure repairs.
- Final repository check: 1,076 total, 1,065 passed, 11 expected skips, no failures
  or cancellations. Web build succeeded; 64 web tests passed after updating stale
  ACP copy assertions. Runtime audit: zero vulnerabilities. Package preview:
  110 files, all three SuperGrok modules included, retired API sources absent.
- Opera GX loaded the real OAuth-only dashboard fixture with six services and
  neutral provider readiness. This was a smoke check, not a new full visual matrix.
- Existing n8n/ngrok remain exited and the existing OpenAI sidecar remains running,
  matching baseline. No existing n8n change, commit, publish or deployment occurred.
- Evidence: the retained local acceptance archive,
  `integration-web-final-tests.log`, `generated-image-final-result.json`,
  `normal-runtime-live-result.json`, and `generated-image-result.json`.
- Next: integrate the reviewed private n8n companion installation path. The normal
  local target still publishes loopback only and does not attach to existing n8n.
  Keep live logout, remaining Opera/native Windows, complete-candidate review and
  protected shipping gates open. Do not request another login while the retained
  runtime remains connected.

## Live SuperGrok and n8n acceptance passed, 2026-09-05

- Official fresh device login completed; the same runtime now reports connected.
  No API key, imported token or additional account was used.
- The first direct request returned HTTP 426. Adding the installed Grok 1.0.13
  client-version header plus the transparent Relmio client identifier/User-Agent
  resolved it. Production `src/supergrok/chat.js` and header assertions match
  the verified request. No version or release metadata was bumped.
- Both direct and production-gateway two-request live tool probes passed:
  Grok called the tool, then consumed a nonce generated after the call.
- Actual pinned n8n 2.36.8 Instance AI called `workflows` with `action: list`,
  matched its result ID, and repeated an unpredictable seeded draft name that
  was absent from the prompt. The run completed successfully.
- Individual draft DELETE failed; the reviewed launcher instead removed the
  entire labelled disposable n8n container and its volume. Both removals were
  verified. This removes the draft too. Original per-check result is retained;
  the separate acceptance report records the successful cleanup method.
- Live streaming cancellation followed by a successful new request passed.
  The session remains signed in; live logout/refusal proof is still open.
- Latest full check: 1,064 tests, 1,053 passed, 11 expected skips, 0 failures.
  Focused header/session checks 13/13. Audit zero vulnerabilities. Package
  preview and git diff --check passed. Fresh Sol/high review repaired fixture
  evidence and exact volume identity; the runtime header delta was inspected
  by the root and verified with focused/full tests and live requests.
- Evidence: the retained local acceptance archive,
  live-n8n-result.json, live-provider-result.json, live-cancellation-result.json,
  and repository-check-headers.log. Synthetic gateway result:
  n8n-fixture/result-relmio-n8n-proof-ab3685b5e7b56f40.json.
- Existing n8n/ngrok/OpenAI sidecar IDs and states match baseline; no remote
  writes, release, publication, or existing n8n changes occurred.
- Remaining: supported setup/CLI/dashboard integration, durable runtime image
  wiring, live logout/refusal and remaining provider/browser/release gates.
  The candidate handler currently runs on private port 10532 inside the same
  freshly signed-in disposable runtime; it is not a released installation.


Status: direct OAuth route approved by the user on 2026-09-05. The selected
implementation uses the official Grok binary for fresh login in a new isolated
runtime and its documented direct HTTP inference endpoint. It does not import
existing credentials or register a new OAuth client. Live acceptance and
release remain gated; existing n8n stays untouched.

## Earlier ACP result

The 2026-09-05 07:57 UTC disposable run passed official device login, then
failed a controller transport bound in prompt phase before MCP readiness.
The exact counter is not present in the saved report. The run removed its
owned resources. The previous reverse-RPC correction is independently tested,
but neither this result nor the correction establishes live MCP tool support.
Attended retries are disabled to stop repeating sign-ins without a better plan.

## Routes considered

| | Keep the official Grok CLI | Dedicated direct OAuth sidecar |
|---|---|---|
| Credential owner | Official Grok runtime | New, isolated Relmio provider runtime |
| Sign-in | Official device flow | Fresh official `grok login --device-auth` inside the new runtime |
| Model transport | ACP, with a pending MCP tool bridged across HTTP requests | HTTP Chat Completions, with ordinary tool calls and matching tool results |
| What n8n executes | Its own Assistant tools | Its own Assistant tools |
| Remaining design risk | Live MCP suspension, permissions, session continuation, cancellation | Fresh session compatibility, client tool exchange and session isolation |
| Evidence today | Live text works; MCP result is unproven | xAI documents direct session-token requests; live direct and n8n tool/result proof passed |

Both routes keep existing n8n untouched and require actual disposable n8n
Assistant acceptance. Neither may use API keys or automatic account switching.

## Selected implementation

1. Provide one dedicated runtime and one isolated credential volume for one
   explicitly chosen account. Relmio's dashboard guides sign-in, status and
   sign-out without returning tokens to the browser or n8n.
2. Run the official pinned `grok login --device-auth` inside the new runtime.
   The CLI owns authorization, refresh and logout. Read only the credential
   file it creates in that same empty, marked private volume. Do not discover
   or import the host `~/.grok/auth.json`, OpenCodex accounts or cookies.
3. Keep credentials inside that runtime with owner-only file modes. The
   official CLI is the sole writer. Relmio does not consume refresh tokens. Never put tokens in prompts,
   model responses, diagnostic output, process arguments or exported plans.
4. Expose a private `/v1/chat/completions` endpoint guarded by a distinct local
   bearer. Convert full tool calls once, preserve stable IDs, and require every
   tool result to match the preceding call. n8n executes the tool and sends its
   result in the next HTTP model request. This eliminates the ACP/MCP suspension
   layer from this route.
5. Expiry or upstream 401 requires fresh official login. Do not add an
   undocumented refresh command or retry authentication automatically. Quota
   errors remain errors; do not pool accounts or use key fallbacks.
6. Verify with a disposable model client and disposable n8n Assistant before
   proposing any companion installation. Existing n8n is never reconfigured,
   restarted or recreated, and no VPS host port is published.

## Provider contract established for this narrower route

The [official xAI README](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/README.md#using-authjson-for-api-access)
explicitly documents calling the CLI chat proxy after `grok login`. This removes
the need for a Relmio OAuth client registration: the official binary performs
the login, and the HTTP caller uses the same runtime's freshly created session.
No client identifier is copied into Relmio's authentication implementation.

The documented endpoint is `https://cli-chat-proxy.grok.com/v1/chat/completions`,
with `X-XAI-Token-Auth: xai-grok-cli` and the selected routing model in
`x-grok-model-override`, alongside the private session bearer. The original
`grok-build` name remains a legacy routing alias; it does not establish which
latest model the provider selects. On September 6, 2026, explicit
`grok-4.6` completed real tool/result round trips in both the user's local n8n
Assistant node catalog and a separate n8n AI Agent Calculator workflow, which
returned `9193` for `317 × 29`. The original OpenAI Assistant selection was
restored. Relmio does not expose a Responses endpoint.

### Account model discovery

The [official Grok 1.0.13 model source](https://github.com/xai-org/grok-build/blob/bb7f39d5858cbf5e00de639367f59debbdcb0138/crates/codegen/xai-grok-shell/src/remote/model_source/oai.rs)
uses `GET https://cli-chat-proxy.grok.com/v1/models` for session authentication.
The live request with the existing runtime-owned OAuth session returned
`grok-4.6` and `grok-4.5`. This is an account response, not a promise that those
names will remain available or that every discovered model has passed tool tests.
The listing is not per-model tool proof.

Relmio's discovery contract is a fresh authenticated catalog request, a bounded
response containing only visible routing model names, and no stale/static list
on a provider or login failure. Catalog metadata must never redirect inference
or supply credentials or headers. In particular, `api_backend` describes the
CLI's preferred transport: the live catalog reported `responses` for the same
Grok 4.6 model that passed Chat Completions tests. It is not an exclusive
capability declaration. Discovery must not switch an existing model selection.

Workflow OpenAI-compatible model nodes can load this catalog through their
**From list** selector. Turn **Use Responses API** off for this Chat Completions
bridge. The preserved n8n 2.36.8 Assistant custom-endpoint dialog uses a model
text field and skips catalog loading, as shown in its
[onboarding component](https://github.com/n8n-io/n8n/blob/n8n%402.36.8/packages/frontend/editor-ui/src/features/ai/instanceAi/onboarding/InstanceAiOnboardingWizard.vue).
Use a discovered routing name in that field. An automatic dropdown inside that
Assistant dialog requires an n8n change and is outside this preserved-instance
implementation. Installation health checks remain local; provider sign-in and
catalog availability are separate readiness checks.

### n8n Chat Hub compatibility

n8n 2.36.8 Chat Hub uses the OpenAI model node v1.3, which defaults to the
Responses API. For this Chat Completions bridge, disable **Use Responses API**
in **Settings > Chat > OpenAI > Edit provider**. The built-in
[provider setting](https://github.com/n8n-io/n8n/blob/459d631218448de541490f116904c2625f185073/packages/frontend/editor-ui/src/features/ai/chatHub/components/ProviderSettingsModal.vue#L351-L368)
is passed into the
[Chat Hub workflow model](https://github.com/n8n-io/n8n/blob/459d631218448de541490f116904c2625f185073/packages/cli/src/modules/chat-hub/chat-hub-workflow.service.ts#L750-L786).
This is a provider-wide Chat setting; it does not change the separate Assistant
connection. Preserve other provider settings and credentials.

The attended local Chat Hub plain-message test passed on September 6 after
this setting change, using the existing Grok 4.6 workflow credential. Chat Hub
tool calls remain untested; the Assistant and workflow AI Agent have separate
verified tool-result round trips.

The README's example credential map key is legacy. Current official
[auth source](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/auth/model.rs)
and [scope construction](https://github.com/xai-org/grok-build/blob/72a61251fcffb464bcc687aeb5a998e5a98ec0c9/crates/codegen/xai-grok-shell/src/auth/config.rs)
require OIDC mode, issuer `https://auth.x.ai`, future expiry and a canonical
issuer/client-ID map key. The reader rejects legacy web login, API keys,
foreign issuers, ambiguous entries and insecure files. Installed Grok 1.0.13
must demonstrate compatibility; the source pin alone is not binary provenance.

`src/supergrok/` contains the isolated session reader and Chat Completions
handler. It is wired into this candidate's runtime, installer, and dashboard;
it is not in the released package. The disposable launcher lives in
the retained local acceptance archive. Local synthetic tests cover fresh-only
storage, private-file checks, tool-result correspondence, stream fragmentation,
and redacted auth/quota failure without retries. Actual n8n 2.36.8 Instance AI
completed the live tool/result loop with cleanup verified. Synthetic proof alone
did not establish provider support.

## Evidence

- Goal: OAuth-only SuperGrok integration for local clients and private n8n.
- Latest run: the retained local acceptance archive.
- [OpenCodex OAuth source](https://github.com/lidge-jun/opencodex/blob/48f8186647d9ffb108d226dcfa91a64225aae2a7/src/oauth/xai.ts).
- [OpenCodex transport](https://github.com/lidge-jun/opencodex/blob/48f8186647d9ffb108d226dcfa91a64225aae2a7/src/providers/xai-transport.ts).
- [OpenCodex provider registry](https://github.com/lidge-jun/opencodex/blob/48f8186647d9ffb108d226dcfa91a64225aae2a7/src/providers/registry.ts).
- [Official Grok ACP integration](https://docs.x.ai/build/cli/headless-scripting).
- [Official CLI OAuth flag](https://docs.x.ai/build/cli/reference).
