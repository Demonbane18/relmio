# Product roadmap

Relmio connects provider-owned OAuth sign-in to private local apps and
self-hosted n8n. Ordinary API-key connections belong in the consuming client.
The current OAuth-only candidate is unreleased. Published 0.13.0 still has a
different set of setup options.

## Preserve existing connections

Keep the ChatGPT/Codex routes, the private `n8n-openai-oauth` bridge, and their
existing deployment identifiers. Do not change an operator's n8n container,
image, Compose file, or network membership. A local dashboard refresh must
remain read-only and must not adopt resources from labels alone.

Remove upstream API-key setup, storage, profiles, gateways, and sidecars from
the candidate. Existing API installations and saved data remain untouched.
Relmio's own local bearer, sandbox key, and ngrok credentials retain their
separate purposes and protections.

## Official SuperGrok OAuth for local apps

The unreleased SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Local apps use `/v1/chat/completions` with model `grok-build` and a separate
Relmio client bearer. n8n executes its own tools and returns matching results.
The legacy simple `/chat` request shape remains available through the direct
transport. Browser bundles must not hold the local bearer or call it directly.

Required acceptance:

- Verify the pinned CLI and direct Chat handler in the generated image.
- Complete fresh official sign-in, tool-call/result exchange and cancellation.
  These passed in the disposable runtime on 2026-09-05.
- Complete explicit logout and generic signed-out refusal without recording
  credentials. Preserve the signed-in test session until that final check.
- Verify Opera GX setup/management, stale inventory, keyboard, mobile widths,
  zoom and reduced motion. Keep runtime health separate from provider readiness.

## SuperGrok OAuth beside n8n

Both n8n and local apps are required clients. Actual n8n 2.36.8 Instance AI
passed live `workflows/list`, matching result ID and final consumption of an
unpredictable draft name omitted from the prompt. The disposable n8n container
and volume were removed after the test. This establishes client tool support;
normal installation and protected release checks still remain.

The companion must publish no host port and must leave the existing n8n
installation unchanged. Test it with a disposable n8n project first. A green
local mock is not live subscription or n8n model-node acceptance.

## Release requirements

Keep runtime health, provider readiness, and inventory freshness independent.
Each OAuth target has one active provider account. Account changes require an
explicit sign-out and sign-in. Relmio never changes accounts automatically
when authentication, entitlement, rate-limit, or quota checks fail.

Complete current-candidate tests, security and protocol review, browser QA,
package inspection, documentation checks, and native Windows evidence before
requesting the protected release actions. Do not guess a release version.

No public gateway, pooled subscription, shared account, quota evasion, or
undocumented credential flow is in scope. Defer a feature when official
interfaces cannot support it safely; record the precise missing capability.

## Research references

- [Grok Build subscription sign-in and orchestration](https://x.ai/news/grok-build-cli)
- [Grok Build authentication and system policies](https://docs.x.ai/build/enterprise)
- [Grok Build headless scripting and ACP](https://docs.x.ai/build/cli/headless-scripting)
- [Codex App Server authentication](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
