# Relmio

Relmio helps you test a supported ChatGPT sign-in in a hosted chat, connect
self-hosted n8n through a separate private Docker sidecar, or install a
loopback-only local endpoint. It keeps ChatGPT/Codex credentials, OpenAI
Platform API keys, and local client capabilities as three different contracts.

## Quick install

On macOS, Linux, WSL, or Git Bash:

```bash
npx --yes --ignore-scripts relmio@latest
```

The local wizard prints a private `127.0.0.1` URL, checks Docker, presents the
exact plan, and asks for final confirmation before it writes local files or a
VPS sidecar. Other install options are on the [hosted install
page](https://relmio.vercel.app/install).

## Endpoints

| Option | Contract | Intended credential/client |
| --- | --- | --- |
| OpenAI API gateway | OpenAI-compatible `/v1` | User-supplied Platform API key; local apps and configured browser origins |
| Codex App Server | Experimental JSON-RPC over WebSocket | ChatGPT sign-in plus a high-trust local capability; trusted native clients |
| Codex Chat Adapter | Experimental `POST /chat` | ChatGPT sign-in plus a local bearer; trusted local backends or development servers |
| n8n sidecar | Private `http://n8n-openai-oauth:10531/v1` | Existing n8n Docker network only |

The Codex targets are not generic `/v1` endpoints. ChatGPT sign-in is never an
OpenAI Platform API key or authorization for arbitrary OpenAI API calls.

## Critical security boundaries

- Local endpoints bind only to `127.0.0.1`; do not expose them through a LAN,
  reverse proxy, domain, or public IP.
- The n8n installer creates a separate sidecar. It never edits the existing
  n8n Compose file or image and never publishes port `10531` on the VPS host.
- The Chat Adapter rejects browser origins. Its new in-wizard tester calls only
  the setup-token-protected local wizard, never the adapter from the browser.
- Local capabilities and the Chat Adapter bearer are sensitive. Do not put
  them in browser code, logs, or a shell command line.

## ChatGPT sign-in lifetime

ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes
them automatically during active use before they expire, so active sessions
usually continue without another browser login. The official [OpenAI
authentication documentation](https://learn.chatgpt.com/docs/auth) does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Common problems

1. **Docker is not running.** Start Docker Desktop or Docker Engine with
   Compose, then reopen one fresh wizard session. See [Docker
   troubleshooting](https://relmio.vercel.app/docs/troubleshooting#docker-is-not-running).
2. **Authentication fails.** Close old wizard and sign-in tabs, use the newest
   printed wizard URL, and retry the device-code flow. See [authentication
   troubleshooting](https://relmio.vercel.app/docs/troubleshooting#authentication-fails).
3. **Local image build failed.** The wizard intentionally hides Docker stderr
   and local paths. Check Docker, disk space, and registry connectivity, then
   start a fresh reviewed plan. See [local image build
   troubleshooting](https://relmio.vercel.app/docs/troubleshooting#local-image-build-failed).

## Documentation

- [Getting started](https://relmio.vercel.app/docs/getting-started)
- [Local endpoints and the Chat Adapter](https://relmio.vercel.app/docs/local-endpoints)
- [VPS and n8n](https://relmio.vercel.app/docs/vps-and-n8n)
- [Troubleshooting](https://relmio.vercel.app/docs/troubleshooting)
- [Security](https://relmio.vercel.app/docs/security)
- [Reference and safe test commands](https://relmio.vercel.app/docs/reference)

For source-level guides, see [`docs/`](docs/). Security guidance is in
[`docs/security.md`](docs/security.md). Relmio is licensed under the
[Apache License 2.0](LICENSE).
