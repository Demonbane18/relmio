<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/brand/relmio-logo-rounded.svg" alt="Relmio gateway android logo" width="180" height="180">
</p>

# Relmio

This package starts Relmio's local setup wizard for private n8n companions or
a loopback-only local endpoint. It supports Node.js 22 or newer.

## Quick install

```bash
npx --yes --ignore-scripts relmio@latest
```

The wizard opens a private `127.0.0.1` page, verifies Docker, and requires a
final confirmation before it writes files or deploys a self-hosted sidecar.

## What it can install

| Option | Contract | Credential boundary |
| --- | --- | --- |
| Local OpenAI gateway | OpenAI-compatible `/v1` | Your OpenAI Platform API key |
| Codex App Server | Experimental JSON-RPC/WebSocket | ChatGPT sign-in and a high-trust local capability |
| Codex Chat Adapter | Experimental `POST /chat` (JSON or opt-in SSE) | ChatGPT sign-in and a bearer for trusted local backends |
| n8n sidecar | Private Docker-network `/v1` bridge | A local ChatGPT sign-in file, never a host port |
| n8n AI Assistant companion | Private sandbox; opt-in SearXNG web search | OpenAI Platform API key entered directly in n8n |

ChatGPT sign-in does not become an OpenAI Platform API key. Codex transports
are not generic `/v1` services and should never be exposed on a LAN or public
network.

## n8n AI Assistant companion

Choose **n8n AI Assistant tools** in the local browser wizard to install Code
Sandbox beside an existing local n8n container. SearXNG JSON web search is
optional and off by default. The reviewed plan binds the exact container,
Docker network, and SearXNG choice. Relmio shows the sandbox key and n8n
environment settings once after verification; it does not change or restart
n8n, and it publishes no host port.

For an SSH-reachable n8n host, use the separate Assistant wizard:

```bash
npx --yes --ignore-scripts relmio@latest assistant
```

Neither path reads ChatGPT/Codex OAuth. ChatGPT/Codex subscription sign-in is not
an OpenAI Platform API key. AI Assistant is Preview, so review generated
workflows before use. This self-hosted path has a privileged Docker-in-Docker runner for
advanced/local testing and publishes no host ports; n8n recommends Daytona for
production. In n8n, enter your own Platform API key directly and keep your
current supported model selection, including `openai/gpt-5.6-sol` while n8n
continues to accept it. A separately deployed, Platform-key-backed Relmio endpoint
may be used through n8n's optional custom endpoint form; its private Relmio
client credential is not an OpenAI-issued API key. The OAuth sidecar remains
experimental/private/policy-uncertain and is never auto-selected.

The experimental Chat Adapter's SSE stream succeeds only after its
`terminal: completed` event. Its local tester stays behind the setup-token-
protected wizard and uses a short-lived encrypted credential handoff, never a
direct browser-to-adapter request.

## OpenAI policy evidence and limits

Relmio's maintainer was accepted into OpenAI's [Codex for Open Source
program](https://learn.chatgpt.com/docs/codex-for-oss-terms) for this project
in August 2026 and received its limited-duration ChatGPT Pro benefit.
OpenAI's [advanced Codex configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers)
documents custom model providers and OSS mode with Ollama or LM Studio.
OpenAI Codex Lead Thibault “Tibo” Sottiaux has publicly distinguished supported
**Sign in with ChatGPT** clients from unsupported subscription-to-API
conversion, resale, or multi-user sharing ([statement](https://x.com/thsottiaux/status/2090675027670978569)),
and [confirmed Codex can use open-source models](https://x.com/thsottiaux/status/2067399435009622521).
OpenAI CEO Sam Altman also [announced ChatGPT-account sign-in for
OpenClaw](https://x.com/sama/status/2050357911915028689).

These sources support specific documented patterns; they are not blanket
approval, protocol certification, a contractual amendment, or legal advice.
Program acceptance supports the maintainer and open-source work; it does not
approve every integration. Relmio never presents ChatGPT credentials as a
generic `/v1` API key, and its n8n AI Assistant path requires a user-owned
OpenAI Platform API key. Relmio prohibits account pooling or sharing,
credential forwarding, subscription-to-API conversion or resale, and
rate-limit or safeguard bypass. The legacy OAuth sidecar remains
experimental/private/policy-uncertain. Read the full
[policy evidence and scope](https://relmio.vercel.app/docs/security#policy-evidence-and-scope).

## ChatGPT sign-in lifetime

ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes
them automatically during active use before they expire, so active sessions
usually continue without another browser login. The official [OpenAI
authentication documentation](https://learn.chatgpt.com/docs/auth) does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Common problems

1. **Docker is not running:** start Docker Desktop or Docker Engine with
   Compose, then open a fresh wizard. See
   https://relmio.vercel.app/docs/troubleshooting#docker-is-not-running.
2. **Authentication fails:** close stale sign-in tabs and use only the newest
   local wizard URL printed by the active terminal. See
   https://relmio.vercel.app/docs/troubleshooting#authentication-fails.
3. **Local image build failed:** check Docker, disk space, and registry
   connectivity; the browser intentionally does not reveal Docker stderr or
   local paths.

Full guides use absolute HTTPS links:

- https://relmio.vercel.app/docs/getting-started
- https://relmio.vercel.app/docs/local-endpoints
- https://relmio.vercel.app/docs/vps-and-n8n
- https://relmio.vercel.app/docs/ai-assistant
- https://relmio.vercel.app/docs/troubleshooting#local-image-build-failed
- https://relmio.vercel.app/docs/security
- https://relmio.vercel.app/docs/reference

Source and issues: https://github.com/Demonbane18/relmio

License: Apache-2.0
