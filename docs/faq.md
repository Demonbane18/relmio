# Frequently asked questions

## Does a ChatGPT plan include a Platform API key?

No. The local `/v1` gateway uses your OpenAI Platform API key and Platform
billing. ChatGPT sign-in stays inside the experimental Codex routes. The n8n
OAuth sidecar is an unofficial, private compatibility bridge. It is not a
general local `/v1` service and is policy-uncertain.

## How long does a ChatGPT/Codex sign-in token last?

ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes
them automatically during active use before they expire, so active sessions
usually continue without another browser login. The official [OpenAI
authentication documentation](https://learn.chatgpt.com/docs/auth) does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Can I expose local endpoints on my network?

No. Local endpoints bind to `127.0.0.1`. Do not port-forward, reverse proxy,
or publish a Codex route.

## Why does the Chat Adapter reject browser requests?

It rejects every request with an `Origin` header. Use a trusted local backend
or development server. The built-in tester talks to the protected wizard,
which makes the server-side adapter request.

## Is the built-in tester end-to-end encrypted?

No. It uses an expiring in-memory RSA-OAEP key to reduce accidental credential
exposure. It is not encryption at rest or end-to-end encryption, and it cannot
protect a compromised browser, extension, or computer.

## Can Relmio modify my n8n deployment?

No. The local and VPS routes add a separate sidecar after you approve the
plan. They do not edit, exec into, rebuild, restart, stop, or recreate n8n.
They never publish port `10531` on the host.

The local **n8n AI Assistant tools** option creates Relmio-owned Code Sandbox
services and optional SearXNG. It publishes no host port and leaves n8n
unchanged. The privileged Docker-in-Docker runner is for local testing. Use
Daytona for production sandboxing.
