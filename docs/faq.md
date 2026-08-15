# Frequently asked questions

## Does a ChatGPT plan include a Platform API key?

No. The OpenAI-compatible `/v1` local endpoint uses a user-supplied OpenAI
Platform API key, with Platform billing. ChatGPT sign-in is only for the
experimental Codex paths and is never represented as generic `/v1`
authorization.

## How long does a ChatGPT/Codex sign-in token last?

ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes
them automatically during active use before they expire, so active sessions
usually continue without another browser login. The official [OpenAI
authentication documentation](https://learn.chatgpt.com/docs/auth) does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Can I expose the local endpoints to my network?

No. Relmio's local endpoint plans bind only to `127.0.0.1`. Do not reverse
proxy or port-forward the Codex targets. They are intended only for the local
machine and their stated trusted-client boundary.

## Why does the Chat Adapter reject browser requests?

The adapter deliberately has no CORS support and rejects requests with an
`Origin` header. It is for a trusted local backend or development server, not
browser bundles. The in-wizard tester is the one narrow exception: the browser
talks only to the setup-token-protected wizard, which makes the server-side
adapter request without an `Origin` header.

## Is the in-wizard tester end-to-end encrypted?

No. It uses an expiring in-memory RSA-OAEP key to reduce accidental credential
transit and storage exposure between the wizard page and local server. It does
not protect against a compromised browser, extension, or local machine, and it
does not provide encryption at rest or end-to-end encryption.

## Can Relmio modify my n8n deployment?

No. It deploys a distinct sidecar only after you approve the displayed plan.
It does not edit existing n8n Compose files or images and never publishes port
`10531` on the VPS host.
