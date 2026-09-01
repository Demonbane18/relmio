<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/brand/relmio-banner-animated.svg" alt="Animated Relmio mascot carrying a private n8n connection through its doorway" width="1200">
</p>

<h1 align="center">Relmio</h1>

<p align="center"><strong>Use ChatGPT sign-in with n8n. Keep every credential where it belongs.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm version" src="https://img.shields.io/npm/v/relmio?logo=npm&amp;color=0f8f83"></a>
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/relmio?color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Demonbane18/relmio?style=flat&amp;logo=github&amp;color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/Demonbane18/relmio/ci.yml?branch=main&amp;label=CI"></a>
  <a href="https://github.com/Demonbane18/relmio/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0f8f83"></a>
</p>

Relmio helps self-hosted n8n use models available through your own
ChatGPT/Codex sign-in. It installs an unofficial `openai-oauth` sidecar on the
same private Docker network as n8n. The bridge has no host port.

ChatGPT sign-in is not an OpenAI Platform API key. Relmio keeps the private
OAuth bridge and the supported Platform API path separate.

## Quick install

```bash
npx --yes --ignore-scripts relmio@latest
```

The command opens a private `127.0.0.1` browser wizard. It checks Docker, shows
the plan, and asks before it writes files or starts containers.

## Pick a path

### Existing n8n model bridge

Sign in with your own ChatGPT/Codex account, select the running n8n container
and Docker network, then install the sidecar. Configure n8n with:

```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: local-only
Responses API: On
```

Relmio does not edit or restart n8n. The bridge is unofficial, private,
experimental, and policy-uncertain.

### New local n8n + ngrok

Create a separate n8n stack when you do not have one yet. The wizard explains
the ngrok domain, token, and Basic Auth fields. Only the new n8n route is
public. Private model and Assistant services keep their host ports closed.

### Supported OpenAI API

Choose **OpenAI API** and enter your own Platform API key. Platform usage is
billed separately from ChatGPT. Relmio gives local clients a different local
credential.

## n8n AI Assistant tools

Choose **n8n AI Assistant tools** in the local browser wizard to add Code
Sandbox. SearXNG web search is optional and off by default. Relmio shows the
sandbox key and n8n settings once. It does not change or restart n8n.

Enter your supported model credential directly in n8n. The privileged local
runner is for development and testing; n8n recommends Daytona for production.

## Codex device sign-in

The experimental Codex options use the official device-code sign-in. The
ChatGPT credential stays inside the isolated Codex container. Use these routes
only with trusted local apps or development backends.

## Sign-in lifetime

ChatGPT/Codex sign-in tokens expire. The official Codex client refreshes them
automatically during active use before they expire, so active sessions usually
continue without another browser login. Official OpenAI documentation does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Common problems

- **Docker is not running.** Start Docker, then open a fresh wizard session.
- **Authentication fails.** Close old sign-in tabs and use the newest local URL
  printed by the active Relmio terminal.
- **Local image build failed.** Check Docker, disk space, and registry access.

## Guides

- https://relmio.vercel.app/install
- https://relmio.vercel.app/docs/getting-started
- https://relmio.vercel.app/docs/local-endpoints
- https://relmio.vercel.app/docs/local-n8n-stack
- https://relmio.vercel.app/docs/ai-assistant
- https://relmio.vercel.app/docs/troubleshooting
- https://relmio.vercel.app/docs/security
- https://relmio.vercel.app/changelog

## Support

Relmio is free to use. If it helped you, you can buy me a coffee.

<a href="https://ko-fi.com/paldogies" target="_blank" rel="noopener noreferrer"><img height="36" src="https://storage.ko-fi.com/cdn/kofi6.png?v=6" alt="Support Relmio on Ko-fi"></a>

Source and issues: https://github.com/Demonbane18/relmio

License: Apache-2.0
