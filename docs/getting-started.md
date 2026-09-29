# Getting started

Relmio provides provider sign-in connections, private n8n companions, and an
optional self-hosted local-model workflow. SuperGrok is available for local apps
and existing n8n deployments on the same computer or a VPS. It uses its own
official device sign-in and never requires or reads ChatGPT credentials.

| Need | Choose | Credential |
| --- | --- | --- |
| SuperGrok for a local backend | Grok Build adapter | Official subscription OAuth and a local bearer |
| SuperGrok for existing local or VPS n8n | Private SuperGrok companion | Official subscription OAuth and a local bearer |
| A trusted native Codex client | Codex App Server | ChatGPT sign-in and a local capability |
| A small local backend | Codex Chat Adapter | ChatGPT sign-in and a local bearer |
| A bridge for local Docker n8n or a VPS | n8n OAuth sidecar | A local ChatGPT sign-in file |
| n8n AI Assistant tools | Code Sandbox, with optional SearXNG | A generated sandbox key and a model credential entered in n8n |
| A provider-free model for a self-hosted n8n workflow | Local model for n8n | No provider sign-in; Ollama's required API-key field is ignored |

ChatGPT sign-in is never converted into an OpenAI Platform API key. The Codex
routes are experimental and are not general `/v1` services. The n8n OAuth
sidecar is unofficial, private, and policy-uncertain. The local-model companion
is a separate unauthenticated Ollama API on a trusted private Docker network; it
uses no OAuth credential or provider key.

## Install

On macOS, Linux, or WSL with Node.js 24 or newer:

```bash
npx --yes --ignore-scripts relmio@latest
```

The stable `@latest` command opens the **ChatGPT on my server** route in a
foreground browser wizard; it remains `0.17.5` and does not include the
redesigned experimental `.3` chooser. The `.2` prerelease is published, while
publication of `.3` is not verified. After publication, opt in with
`npx --yes --ignore-scripts relmio@0.18.0-experimental.3`.

On a first-run machine with no `.relmio` directory and no local n8n stack, the
wizard still opens and presents missing prerequisites as steps. Use `relmio
local` only when you explicitly want the setup route for this computer. In
experimental `.3`, choose the server route before ChatGPT sign-in. The five
visible steps are **Choose setup**, **Check server**, **Choose n8n**,
**Review**, and **Ready**. Enter the server address and port, independently
compare and confirm the SSH fingerprint, then enter the SSH username and
choose authentication. After connecting, select the n8n container and
network, then review the plan. Review identifies the currently verified SSH
identity as the recipient of the complete credential file. Going back or
changing the connection clears the reviewed plan and approval, so review
again before the separate final confirmation for remote writes. Expand
**More details** for optional explanations; required choices and plan review
stay in the main flow. Local endpoints use `127.0.0.1`; the n8n bridge and
Assistant tools use one selected Docker network and publish no host port.
SearXNG is off by default.

On Git Bash, use the hosted launcher. It downloads a checksum-verified temporary
Node.js runtime and uses Git for Windows' bundled `winpty` bridge so the wizard
keeps its interactive terminal:

```bash
curl -fsSL https://relmio.jpfusin.tech/install.sh | sh
```

Direct NPX on Git Bash 2.38.1 still needs `MSYS=enable_pcon` for that one
process. Native PowerShell and Command Prompt installers are also available.

## Existing cloud n8n and SSH access

For a provider-free model on an existing Linux VM, choose **Local model · your
VPS**. Hosting guidance covers Hetzner, Contabo, AWS EC2/Lightsail, DigitalOcean
Droplets and OCI Compute. Enter the actual image/administrator username, use a
key already loaded into a local SSH agent or an approved password, verify the
host fingerprint, and review the final plan. Relmio does not collect private
keys or change SSH policy.

The host needs rootful Docker Engine, Compose v2 and Buildx targeting that same
local daemon, a running official n8n container on an eligible existing bridge,
sufficient measured resources and a safe preexisting root-owned `/docker`.
The model route can use verified
**Passwordless sudo -n (model only)**; OAuth bridge, AI Assistant and SuperGrok
VPS routes still require existing approved direct-root access. Agent setup
does not grant sudo or expand those routes.

Render's service SSH is not host administration. A separate paid Render private
model service is possible with manual setup, its own persistent disk and
internal DNS; it is not a Relmio-managed deployment. Read
[Hosting compatibility](hosting-compatibility.md) before choosing a route.

## Keep the dashboard available

Install a persistent command with Node.js 24 or newer, then use its explicit
lifecycle commands:

```bash
npm install --global --ignore-scripts relmio@latest
relmio start
relmio status
relmio open
relmio stop
```

`relmio start` runs the owner-scoped dashboard in the background. `relmio
status` verifies only that process without printing its private session value.
`relmio open` starts it when needed and opens its private page. `relmio stop`
stops only that process; it does not stop or restart n8n, ngrok, endpoints,
bridges, Assistant companions, or unrelated containers.

The hosted curl, PowerShell, and Command Prompt launchers can use a verified
temporary runtime. Git Bash always uses that path so its native Node child can
run through `winpty`. In those cases the wizard remains a foreground, one-shot
process and ends with that terminal session. The temporary runtime is removed,
so install Relmio persistently before relying on these lifecycle commands.

## Choose a guide

- [Local dashboard](./local-dashboard.md) for launch commands, service states,
  available actions, and credential boundaries.
- [Local endpoints](./local-endpoints.md) for the gateway, Codex, the Chat
  Adapter, the n8n bridge, and local Assistant tools.
- [New local n8n + ngrok](./local-n8n-stack.md) if you do not already run n8n.
- [AI Assistant companion](./ai-assistant.md) for Assistant setup and its
  limits.
- [VPS and n8n](./vps-and-n8n.md) for the remote sidecar route.
- [Private local models](./local-models.md) for measured capacity, model
  choices, local/VPS installation, network trust, and explicit cache removal.
- [Hosting compatibility](./hosting-compatibility.md) for VM, PaaS, and
  container-platform boundaries.
- [SuperGrok on a VPS](./vps-supergrok.md) for the provider-specific VPS flow.
- [Troubleshooting](./troubleshooting.md) when setup stops.
- [Security](./security.md) for account, network, and credential rules.
