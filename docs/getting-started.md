# Getting started

Relmio sets up provider sign-in connections for local apps, private companions
for n8n, and an optional self-hosted local-model workflow. SuperGrok is available
for local apps and existing n8n deployments on the same computer or a VPS. It
uses its own official device sign-in and never requires or reads ChatGPT
credentials.
| Need | Choose | Credential |
| --- | --- | --- |
| SuperGrok for a local backend | Grok Build adapter | Official subscription OAuth and a local bearer |
| SuperGrok for existing local or VPS n8n | Private SuperGrok companion | Official subscription OAuth and a local bearer |
| Trusted native Codex client | Codex App Server relay | SIWC registration and a high-trust local bearer |
| Read-only local Codex chat | Codex Chat Adapter | SIWC registration and a separate local bearer |
| ChatGPT plan use from local or self-hosted n8n | Private OpenAI-compatible sidecar | Separately granted ChatGPT plan permission and a one-time local Relmio bearer |
| n8n AI Assistant tools | Code Sandbox, with optional SearXNG | A generated sandbox key and a model credential entered in n8n |
| Provider-free model for a self-hosted n8n workflow | Local model for n8n | No provider sign-in; Ollama's required API-key field is ignored |

Identity sign-in, plan permission, and successful model access are separate.
ChatGPT sign-in is not an OpenAI Platform API key. Relmio does not import a
personal Codex login, merge accounts by email, or fall back to Platform API
billing. The website's `/api/chat` returns `410 Gone`; local SIWC setup does
not enable hosted inference. See the
[2026-10-05 source check](openai-source-check-2026-10-05.md).

## Install

On macOS, Linux, or WSL with Node.js 24 or newer:

```bash
npx --yes --ignore-scripts relmio@latest
```

The foreground wizard opens on `127.0.0.1` without creating persistent Relmio
state. On a first-run machine with no `.relmio` directory or local n8n stack,
it still opens and presents missing prerequisites in the browser. Choose
**ChatGPT on my server** to use the local sign-in and VPS flow; use
`relmio local` only when you explicitly want setup for this computer.

The ChatGPT flow stores each verified registration separately. If the
provider grants identity but not `chatgpt.tokens.use.direct`, the account
remains connected without plan use. Enable that permission in a separate
ChatGPT consent step. Confirm the first-use plan notice before model access;
**Manage usage** opens ChatGPT's usage settings. Existing personal Codex
credentials are never imported.

After an install, **Plan and usage** shows the requests sent through the n8n
sidecar in the last 30 days. Relmio shows no plan percent, reset time or
credits; they stay on ChatGPT's Usage page. See
[VPS and n8n](vps-and-n8n.md#see-plan-and-usage) and
[the local dashboard](local-dashboard.md#plan-and-usage).

The VPS wizard has five visible steps: **Choose setup**, **Check server**,
**Choose n8n**, **Review**, and **Ready**. It confirms the SSH fingerprint
before authentication. Review shows the verified server identity and exact
write plan; the final remote-write confirmation is separate. For transfer,
Relmio initializes a distinct destination host ID, freezes the source session,
and makes the destination the sole refresh owner after it verifies a receipt.
An unknown transfer outcome stays frozen for inspection.

Local endpoints use `127.0.0.1`; the n8n sidecar joins one selected private
Docker network and publishes no host port. Installing for n8n also requires
explicit consent for background workflows. Relmio returns a local bearer once
for manual entry in n8n; it never puts the provider token in the browser or
silently edits n8n credentials.

On Git Bash, use the hosted launcher. It downloads a checksum-verified temporary
Node.js runtime and uses Git for Windows' bundled `winpty` bridge so the wizard
keeps its interactive terminal:

```bash
curl -fsSL https://relmio.jpfusin.tech/install.sh | sh
```

Direct NPX on Git Bash 2.38.1 still needs `MSYS=enable_pcon` for that one
process. Native PowerShell and Command Prompt installers are also available.

## Use the setup guide

The first time you open the wizard, it asks whether to start the setup guide.
Relmio, the mascot from the logo, then takes you through the page one quest
at a time, such as **Check your server**. It points at the box or button you
need with a short label like **Type here** or **Press this** and says what it
is for in plain words. Where it helps, it shows an example such as
`203.0.113.10`, and **Where do I find this?** says where to look the value
up. Examples are documentation values, and the guide never types into a
field for you.

**Next tip** and **Back** move between tips. **Show me** points at the
quest's tips one after another, then scrolls to the one you need and moves
focus to it. A key press, click, scroll or touch stops it. If your system is
set to reduce motion, it numbers the tips instead. Each finished quest earns
a badge, and the Ready screen lists your badges and next steps.

If a step fails, the guide explains the error, lists what to do next and
points at the control that fixes it. With the guide off, a **Need help with
this error?** button opens the same help.

The down arrow at the top of the guide (**Hide guide**), or Escape while the
guide has focus, folds it into a small **Guide** button. **Skip guide** turns
it off. The **Setup guide** button in the top bar, or in the menu on very
narrow windows, turns it on or off at any time. Every wizard page has the
guide, including the dashboard on this computer, the Assistant wizard and
**Hosting options**.

Relmio saves only the on or off choice, in `ui-preferences.json` in the
ChatGPT sign-in folder (`N8N_OPENAI_OAUTH_HOME`, or `~/.n8n-openai-oauth`), so
the next run remembers it. See [Security](security.md#what-the-wizard-does).

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
