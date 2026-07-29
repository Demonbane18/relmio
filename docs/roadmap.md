# Product roadmap

This roadmap describes intended research and product direction. It is not a
promise that a provider, subscription tier, or unofficial integration will
remain available. Every provider must pass its own technical, security, terms,
and entitlement checks before Relmio presents it as supported.

## Product direction

Relmio currently gives self-hosted n8n a private OpenAI-compatible endpoint
backed by a supported ChatGPT/Codex OAuth sign-in. The longer-term product is a
provider-neutral local gateway:

```text
OpenAI-compatible client
  -> private Relmio endpoint
    -> selected provider adapter
      -> provider-authorized OAuth or API access
```

The client should not need to understand each provider's authentication flow.
Provider credentials must remain isolated from one another, protected like
passwords, and excluded from responses, logs, package contents, and Git.

## Before the first npm publication

- Finalize the public name while the package is still unpublished.
- Screen the chosen name for pronunciation, search collisions, npm and GitHub
  availability, relevant domains, and appropriate trademark review.
- Keep the existing `n8n-openai-oauth` deployment identifiers until a tested
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

## Milestone 2: SuperGrok / xAI OAuth feasibility

Research as of July 29, 2026 indicates this is technically plausible:

- xAI's official Grok Build documentation supports browser OAuth and a
  device-code flow, stores credentials locally with owner-only permissions,
  and refreshes access tokens automatically.
- Hermes Agent documents an `xai-oauth` provider for SuperGrok and X Premium+
  using xAI's Responses-style endpoint at `https://api.x.ai/v1`.
- Hermes also documents an important limitation: OAuth can succeed while xAI
  inference returns HTTP 403 because access is gated by subscription tier or
  account entitlement.

Relmio should run a dedicated feasibility spike before promising support:

1. Confirm current xAI terms and whether Relmio can register or use an
   approved public OAuth client for this purpose.
2. Prefer Relmio's own approved client registration or an officially
   supported xAI integration. Do not copy Hermes credentials, browser cookies,
   or another application's private client material.
3. Test browser and headless device-code login, refresh-token rotation,
   revocation, expiry, and logout with a non-production account.
4. Test entitlement behavior across the intended SuperGrok tiers and preserve
   HTTP 403 as an unsupported-account result; never work around provider gates.
5. Prototype `/v1/models`, `/v1/responses`, streaming, reasoning, and
   tool-calling through a provider adapter.
6. Verify the resulting endpoint in n8n's OpenAI Chat Model, AI Agent, Basic
   LLM Chain, and HTTP Request nodes.
7. Repeat the current secret-handling and network-safety review: owner-only
   credentials, no token logging, no public host port, and no n8n mutation.

### Decision gate

- **Proceed:** xAI authorizes the OAuth client and tested subscription tiers,
  refresh works reliably, and the required n8n/OpenAI-compatible contracts
  pass.
- **Defer:** the flow works only through unstable or undocumented behavior.
- **Do not implement:** support would require cookie scraping, copied client
  credentials, bypassing entitlement controls, or violating current terms.
  Document the official xAI API-key route as the fallback instead.

## Not in the first provider expansion

- Publicly exposing the gateway to the internet.
- Pooling or sharing subscriptions between users.
- Bypassing quotas, provider safeguards, or subscription-tier restrictions.
- Automatically routing one request across multiple paid accounts.
- Claiming complete OpenAI compatibility when a provider supports only a
  subset of the protocol.

## Research references

- [xAI Grok Build authentication](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
- [Hermes Agent: xAI Grok OAuth](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/xai-grok-oauth.md)
- [Hermes Agent provider documentation](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md)
