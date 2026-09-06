# Product roadmap

Relmio connects provider-owned OAuth sign-in to private local apps and
self-hosted n8n. Ordinary API-key connections belong in the consuming client.
Relmio 0.14.0 adds SuperGrok for local apps and existing local or VPS n8n without
requiring a ChatGPT credential. The adapter remains experimental.

## Preserve existing connections

Keep the ChatGPT/Codex routes, the private `n8n-openai-oauth` bridge, and their
existing deployment identifiers. Do not change an operator's n8n container,
image, Compose file, or network membership. A local dashboard refresh must
remain read-only and must not adopt resources from labels alone.

Keep upstream API-key setup, storage, profiles, gateways, and sidecars out of
0.14.0. Existing API installations and saved data remain untouched.
Relmio's own local bearer, sandbox key, and ngrok credentials retain their
separate purposes and protections.

## Official SuperGrok OAuth for local apps

The experimental SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Local apps use `/v1/chat/completions` with a freshly discovered model and a
separate Relmio client bearer. `grok-build` remains a legacy routing alias. n8n
executes its own tools and returns matching results.
The legacy simple `/chat` request shape remains available through the direct
transport. Browser bundles must not hold the local bearer or call it directly.

Acceptance evidence and remaining work:

- Verify the pinned CLI and direct Chat handler in the generated image.
- Complete fresh official sign-in, tool-call/result exchange and cancellation.
  These passed in the disposable runtime on 2026-09-05.
- Explicit logout and generic signed-out refusal passed on the disposable
  Windows setup without recording provider credentials.
- Native Windows and Opera GX live paths passed, but the original full gate is
  conditional. Git Bash 2.38.1 requires per-process `MSYS=enable_pcon`; its
  default mintty setup failed the TTY check, and no upgraded version was tested.
- The user reported VPS Chat success after turning Responses API off. That run
  was not independently captured, and VPS Assistant and Calculator remain open.

## SuperGrok OAuth beside n8n

Both n8n and local apps are required clients. Actual n8n 2.36.8 Instance AI
passed live `workflows/list`, matching result ID and final consumption of an
unpredictable draft name omitted from the prompt. The disposable n8n container
and volume were removed after the test. This establishes client tool support;
normal installation now supports local and VPS n8n. VPS Assistant and Calculator
acceptance remain separate.

The companion must publish no host port and must leave the existing n8n
installation unchanged. Test it with a disposable n8n project first. A green
local mock is not live subscription or n8n model-node acceptance.

## Release requirements

Keep runtime health, provider readiness, and inventory freshness independent.
Each OAuth target has one active provider account. Account changes require an
explicit sign-out and sign-in. Relmio never changes accounts automatically
when authentication, entitlement, rate-limit, or quota checks fail.

Complete the current Mac tests, security and protocol review, browser QA,
package inspection, and documentation checks before requesting protected release
actions. Windows evidence does not establish that the full gate passed on Mac.

No public gateway, pooled subscription, shared account, quota evasion, or
undocumented credential flow is in scope. Defer a feature when official
interfaces cannot support it safely; record the precise missing capability.

## Research references

- [Grok Build subscription sign-in and orchestration](https://x.ai/news/grok-build-cli)
- [Grok Build authentication and system policies](https://docs.x.ai/build/enterprise)
- [Grok Build headless scripting and ACP](https://docs.x.ai/build/cli/headless-scripting)
- [Codex App Server authentication](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#auth-endpoints)
