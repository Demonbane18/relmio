# Frequently asked questions

## Does a ChatGPT plan include a Platform API key?

No. The managed provider-authentication flows use their documented OAuth
sessions; they do not create an OpenAI Platform API key. Relmio's newer hosting
planner is a separate operator-generated artifact flow, and API-key connections
are configured directly in n8n or your app. The ChatGPT n8n OAuth bridge
remains unofficial, private, and policy-uncertain.

## Can I use my SuperGrok subscription?

Yes. The experimental Grok Build adapter uses the official CLI's OAuth and a
separate local Relmio bearer. It supports local apps and private n8n companions
on the same computer or a VPS. It does not require ChatGPT sign-in, request an
xAI API key, or fall back to separately billed API access.

For n8n, SuperGrok requires **Use Responses API** off. The OpenAI OAuth/Codex
recipe uses the switch on in OpenAI Chat Model node version 1.3.

## Can I run a model privately beside self-hosted n8n?

Yes. Relmio can manage one CPU-based Ollama model on the selected existing
Docker network, with no published host port and no provider sign-in. The local
API has no authentication, so trust every container on that network. Docker
must have enough measured resources, and image/model downloads need outbound
internet even though Ollama cloud features are disabled. See
[Private local models](local-models.md) and
[Hosting compatibility](hosting-compatibility.md).

This workflow Chat Model is separate from n8n AI Assistant's sandbox and does
not establish reliable tool calling. n8n Cloud cannot host the managed sidecar;
that does not rule out separately configured external endpoints.

## How long does a ChatGPT/Codex sign-in token last?

The Codex authentication guide describes automatic refresh but does not give a
fixed token lifetime. Relmio's private bridge and hosted chat demo each refresh
their own credential copies. OpenAI's one-hour access-token and rotating
30-day refresh-token lifetimes describe the separate Sign in with ChatGPT
plan-usage flow, not Relmio's pinned Codex flow.

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
