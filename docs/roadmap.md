# Product roadmap

This roadmap describes intended research and product direction. It is not a
promise that a provider, subscription tier, or unofficial integration will
remain available. Every provider must pass its own technical, security, terms,
and entitlement checks before Relmio presents it as supported.

## Product direction

Relmio currently keeps three different boundaries explicit: a supported
OpenAI Platform API path, official Codex App Server targets that own their
ChatGPT sign-in, and an unofficial private n8n bridge. The longer-term product
is a provider-neutral local gateway:

```text
OpenAI-compatible client
  -> private Relmio endpoint
    -> selected provider adapter
      -> provider-authorized OAuth or API access
```

The client should not need to understand each provider's authentication flow.
Provider credentials must remain isolated from one another, protected like
passwords, and excluded from responses, logs, package contents, and Git.

Keep the existing `n8n-openai-oauth` deployment identifiers until a tested
migration exists; public branding must not silently change safety boundaries.

## Milestone 1: provider-neutral foundation

- Define a provider adapter contract for authentication, token refresh, model
  discovery, request transport, streaming, and normalized errors.
- Keep the current ChatGPT/Codex implementation working while separating its
  provider-specific behavior from the n8n installation workflow.
- Define capability reporting so clients can distinguish Responses API,
  chat-completions, streaming, reasoning, and tool-calling support.
- Add contract tests that can be run against fakes without storing real OAuth
  credentials in fixtures.
- Design future non-n8n client access under a separate threat model. The
  current private-network and no-published-port rules remain in force until
  that design is approved and tested.

### Exit criteria

- The current n8n setup behaves exactly as before.
- A provider can be added without weakening SSH verification, confirmation
  gates, credential handling, or the private sidecar boundary.
- Unsupported provider capabilities fail explicitly instead of being silently
  translated into a different behavior.

## Milestone 2: xAI/Grok API-key support

xAI's public inference API documents API-key authentication. It does not document a third-party Grok OAuth flow
that Relmio can safely register or ship.
The first xAI integration must therefore use an operator-supplied xAI API key,
keep it in a provider-specific owner-only credential store, and never present
consumer Grok or X subscription sign-in as interchangeable with API access.

Before implementation:

1. Define an xAI adapter that declares only the models and request features the
   official API documents.
2. Keep the key outside browser responses, logs, generated Compose files, and
   package contents. The dashboard may report only that a key is configured.
3. Preserve 401 and 403 as authentication or entitlement failures and 429 as a
   rate-limit response. Relmio never automatically switches accounts or keys.
4. Test `/v1/models`, Responses-style requests, streaming, reasoning, and tool
   support against documented contracts and provider-approved test credentials.
5. Verify the adapter through the intended n8n nodes without editing or
   restarting the operator's n8n deployment.

### Exit criteria

- Every capability is grounded in current official xAI documentation.
- A configured key remains isolated, replaceable only by an explicit owner
  action, and never returned or re-shown.
- Unsupported models, entitlements, and protocol features fail explicitly.
- Provider authentication remains denied by default for every unimplemented
  method.

## Milestone 3: provider-supported OAuth feasibility

OAuth work remains blocked unless the provider publishes a third-party flow
and offers a provider-owned OAuth client registration appropriate for Relmio.
An OAuth feasibility spike may begin only after that documentation exists.

The decision gate is fail closed:

- **Proceed:** the provider approves the client, documents authorization,
  refresh, revocation, expiry, and logout, and the reviewed implementation
  passes security and n8n contract tests.
- **Defer:** the flow exists only in a first-party application or through
  unstable, undocumented behavior.
- **Do not implement:** support would require cookies, copied client IDs or
  secrets, another application's credential store, entitlement workarounds,
  account pooling, or rate-limit circumvention.

## Not in the first provider expansion

- Publicly exposing the gateway to the internet.
- Pooling or sharing subscriptions between users.
- Bypassing quotas, provider safeguards, or subscription-tier restrictions.
- Automatically routing one request across multiple paid accounts.
- Automatic account or key failover after a 401, 403, or 429 response.
- Claiming complete OpenAI compatibility when a provider supports only a
  subset of the protocol.

## Research references

- [OpenAI Codex App Server authentication](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)
- [xAI inference API authentication](https://docs.x.ai/developers/rest-api-reference/inference)
- [xAI rate limits](https://docs.x.ai/developers/rate-limits)
- [xAI Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy)
