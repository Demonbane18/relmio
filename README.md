<p align="center">
  <img src="docs/images/brand/relmio-banner-animated.svg" alt="Animated Relmio mascot carrying a private n8n connection through its doorway" width="1200">
</p>

<h1 align="center">Relmio</h1>

<p align="center"><strong>Bring your AI sign-ins to your tools. Keep every credential where it belongs.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm version" src="https://img.shields.io/npm/v/relmio?logo=npm&amp;color=0f8f83"></a>
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/relmio?color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Demonbane18/relmio?style=flat&amp;logo=github&amp;color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/Demonbane18/relmio/ci.yml?branch=main&amp;label=CI"></a>
  <a href="LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0f8f83"></a>
</p>

Relmio helps self-hosted n8n and local apps use models through your own
ChatGPT/Codex or SuperGrok sign-in. Each provider keeps its own private OAuth
session. SuperGrok setup does not require or read ChatGPT credentials.

Provider-owned OAuth stays in its private runtime, except for the existing
n8n OpenAI bridge: it starts Codex sign-in on the host and copies the complete
credential JSON into its selected private sidecar after confirmation. API-key
connections and operator-generated hosting artifacts are configured separately
in n8n or the target platform. ChatGPT sign-in is not an OpenAI Platform API key.

> [!WARNING]
> **Relmio 0.18.0-experimental.4 is an opt-in prerelease.** Earlier
> private-candidate model-only checks do not verify this artifact, full-stack
> behavior, hosting-provider support, throughput, or model quality. Use a
> test setup. Stable `0.17.5` remains npm `latest` and the hosted installers'
> default. Use this exact pinned command for the experimental wizard:
>
> ```bash
> npx --yes --ignore-scripts relmio@0.18.0-experimental.4
> ```

See the [2026-09-29 source review and wizard consent correction](docs/openai-source-check-2026-09-29.md), the [2026-09-28 source review follow-up, data flows, and unknowns](docs/security.md#2026-09-28-private-candidate-openai-source-check), and the historical [2026-09-27 source review](docs/security.md#2026-09-27-openai-and-hosting-source-review).

The five-step chooser below is experimental. Stable `@latest` remains
`0.17.5` and does not include the redesigned chooser.

The hosted chat and the browser wizard's **Test AI Chat** console keep partial
response text visible while it streams. Their status distinguishes connection
setup, waiting for the first words, active streaming, completion, interruption,
and failure without announcing every token to assistive technology. **Stop
response** preserves text already received, and reduced-motion preferences keep
the same state cues without animation. This presentation does not change the
Chat Adapter protocol or external clients such as n8n.

SuperGrok is a first-class local and VPS setup option in 0.14.0, but the adapter
remains experimental. Live Windows checks covered fresh sign-in, model discovery,
n8n Chat, Assistant node search, and a Calculator workflow. Native Windows CI also
exercises the hosted Git Bash launcher through a real hidden console and verifies
that its portable Node child receives terminal handles. VPS Chat success was
user-reported after Responses API was turned off; VPS Assistant and Calculator
remain unverified.

Existing API-key endpoints are left running and retain their data during an
upgrade; they are no longer shown in the 0.15.0 dashboard. Follow the
[legacy endpoint retirement guide](https://relmio.jpfusin.tech/docs/local-endpoints#retired-api-installations)
to review and stop an exact owned endpoint.

## Quick install

With Node.js 24 or newer on macOS, Linux, WSL, Windows PowerShell, or Command
Prompt:

```bash
npx --yes --ignore-scripts relmio@latest
```
This remains the stable `0.17.5` channel; `@latest` does not select the
experimental prerelease. Use one of the explicit commands near the top of this
guide to opt in. Hosted installers also remain on the stable default.

On Git Bash, use the hosted launcher. It uses Git for Windows' bundled `winpty`
bridge and a checksum-verified temporary Node.js runtime, even when Node.js 24
is already installed:

```bash
curl -fsSL https://relmio.jpfusin.tech/install.sh | sh
```

If you deliberately run NPX directly from Git Bash 2.38.1, prefix that one
process with `MSYS=enable_pcon`. This does not change global Git configuration.

The command opens the **ChatGPT on my server** route in a foreground setup
wizard on `127.0.0.1` without creating persistent Relmio state. It also works
on a first-run machine with no `.relmio` directory and no local n8n stack;
missing prerequisites appear as actionable steps in the browser instead of
ending the launcher before the page opens. Review exactly what the wizard will
create, then confirm the install. Use `relmio local` only when you explicitly
want the setup route for this computer.

No Node.js yet? The hosted guide has native curl, Homebrew, PowerShell, and
Command Prompt options. Homebrew installs the persistent `relmio` command; it
does not launch the browser. The curl, PowerShell, and Command Prompt
launchers open the foreground wizard with the same platform security checks.

[Open the hosted install guide](https://relmio.jpfusin.tech/install)

## Keep the local dashboard available

For a persistent command, install Relmio with Node.js 24 or newer, then manage
its owner-scoped loopback dashboard explicitly:

```bash
npm install --global --ignore-scripts relmio@latest
relmio start
relmio status
relmio open
relmio stop
```

Without a global install, repeat the full NPX command for each lifecycle
action:

```bash
npx --yes --ignore-scripts relmio@latest start
npx --yes --ignore-scripts relmio@latest status
npx --yes --ignore-scripts relmio@latest open
npx --yes --ignore-scripts relmio@latest stop
```

`relmio start` runs the dashboard in the background without opening a browser.
`relmio open` starts it when needed and opens its private local page.
`relmio status` checks only the verified dashboard process without printing a
session value. `relmio stop` stops only that process; it does not stop or
restart n8n, ngrok, model endpoints, bridges, Assistant companions, or
unrelated containers.

The hosted curl, PowerShell, and Command Prompt launchers can use a verified
temporary Node.js runtime. In that mode Relmio remains a foreground, one-shot
process for that terminal and leaves no persistent command behind.

## Upgrade from 0.13.0 and update existing bridges

After installing 0.15.0, run `relmio stop`, then `relmio start` or `relmio
open`. Relmio never reuses a dashboard from another version. The upgrade leaves
existing API-key gateway containers and credential volumes untouched, and the
0.15.0 dashboard does not manage them. It also refuses to adopt an earlier
SuperGrok development install that lacks the fresh-session marker; review that
installation before removal or migration.

Installing a newer Relmio package does not update an OpenAI bridge that is
already running. After installing a Relmio release that contains the latest
bridge compatibility fix, open the dashboard and update the owned bridge:

- For a local n8n bridge, refresh status, select **OpenAI OAuth bridge**, choose
  **Manage bridge**, read the runtime update summary, select its confirmation
  checkbox, then choose **Update bridge runtime**. This keeps the existing
  ChatGPT sign-in, Docker network, and bridge identity.
- For a VPS bridge, run `relmio vps`, reconnect, verify the SSH host fingerprint,
  and select the n8n container and network. Choose **OpenAI-OAuth/Codex bridge**,
  then **Manage OpenAI-OAuth/Codex bridge** and **Review bridge update**. Review
  the plan, select its confirmation checkbox, then choose **Update the bridge**.

Both actions recreate only Relmio's owned sidecar. The local runtime update
keeps its saved sign-in. The VPS update uploads the current local sign-in. They
do not edit, restart, or recreate n8n, and they do not publish port `10531`.
The VPS wizard performs the SSH update from the browser flow, so no separate
VPS terminal is required. Use **Apply sign-in to owned bridge** only when the
local bridge needs a newer ChatGPT sign-in; that action does not update the
bridge runtime.

**Refresh status** shows eight dashboard services: Codex App Server, Codex Chat
Adapter, Grok Build, the owned n8n stack, the ChatGPT OAuth bridge, AI Assistant
tools, SuperGrok for n8n, and the local model for n8n. It shows only verified
connection URLs and state, never stored secrets. Select **Add connection** to
use the existing four-step setup flow. Bare `relmio` and `relmio vps` open the
VPS setup directly. Use `relmio local` for the setup route on this computer.

Choose **Set up SuperGrok for n8n** in the VPS wizard to add
the same private Grok OAuth companion to an existing remote n8n. Review the exact
plan before installation, then complete official device sign-in in your browser.
See [SuperGrok on a VPS](docs/vps-supergrok.md) for Chat Completions settings and
ownership-safe management. No existing n8n restart or provider change is required.

[Learn how to use the local dashboard](docs/local-dashboard.md)

## Pick a path

### I already run n8n

Choose the provider connection or local model that fits the workflow. The
Responses API switch is specific to each integration:

| Connection | Base URL | Value for n8n's API-key field | Use Responses API |
| --- | --- | --- | --- |
| OpenAI OAuth with ChatGPT/Codex sign-in | `http://n8n-openai-oauth:10531/v1` | `local-only` placeholder | **On** in the Relmio OpenAI Chat Model v1.3 recipe |
| SuperGrok OAuth | `http://n8n-supergrok:14502/v1` | One-time local Relmio bearer | **Off** for workflow model nodes and Chat Hub |
| Local Ollama model for n8n | `http://n8n-local-model:11434/v1` | `local-only` ignored placeholder | **Off** for the Chat Completions recipe |

Choose **ChatGPT for n8n**. Other local tools are available under **More connections and tools**.

### Review hosting and integration plans

Open **Hosting options** from the authenticated wizard to compare managed
local/VM setup with operator-applied private deployment artifacts. The catalog
includes 15 Linux VM presets plus local Docker, manual model/search artifacts
for supported platforms, Daytona configuration handoffs for 15 self-hosted
n8n platforms, authenticated endpoint handoffs, and restricted edge relays.
Generate displays validated settings, requirements, steps and source links;
download the complete ZIP to preserve nested paths, or individual files.

Plan generation does not connect to provider accounts, inspect remote hosts,
provision resources, apply files, or edit/restart your existing n8n. Do not put
secrets in planner inputs; artifact secrets are supplied separately through
the provider's secret facility. All newly researched provider runtime
acceptance is **NOT-RUN**. Manual recipes are not the existing managed SSH
installer. See [Hosting compatibility](docs/hosting-compatibility.md) for
platform constraints and the
[AI Assistant guide](docs/ai-assistant.md#operator-managed-daytona-handoff)
for the external sandbox handoff.

The planner's external endpoint profiles for n8n Cloud, Vercel, Netlify and
Cloudflare Workers are authenticated HTTP integrations, not a general URL
proxy or native n8n adapter. Cloudflare Container SearXNG uses an authenticated
Worker route and an n8n HTTP Request tool; native Assistant header-auth setup
is not interchangeable. Vercel/Railway/Cloudflare Sandbox SDKs also remain
separate from native n8n sandbox providers.

The OpenAI bridge remains a separate experimental managed local/VM route. The
official Sign in with ChatGPT article describes identity-only partner sign-in;
it does not describe Relmio's full Codex credential-copy bridge or grant its
permissions. Review the
[source-check findings and data flow](docs/security.md#2026-09-26-openai-source-check)
before use. No hosting catalog entry makes an OpenAI permission, account
entitlement, or successful model/runtime claim.


For the provider-free local model, choose **Local model for n8n** and follow
the reviewed resource/download flow. The API is unauthenticated, so trust every
container on the selected Docker network. See [Private local models](docs/local-models.md)
for capacity, the exact local/VPS setup, n8n settings, and explicit cache
removal.


In experimental `.4`, the VPS wizard shows five steps: **Choose setup**,
**Check server**, **Choose n8n**, **Review**, and **Ready**. Choose the ChatGPT
route before signing in. Enter the server address and port, independently
compare and confirm its SSH fingerprint, then enter the SSH username and
choose authentication. After connecting, select the running n8n container
and its private Docker network. Review names the currently verified SSH
identity as the recipient of the complete ChatGPT/Codex credential file.
Going back or changing the connection clears the reviewed plan and approval;
a separate confirmation is required before any remote write. In n8n, use
`http://n8n-openai-oauth:10531/v1` with the placeholder API key `local-only`.

**GPT Image 2.5.** New bridge installations include Flare and Sunburst in model
discovery. For an existing owned bridge, use its browser **Update bridge runtime**
action (local) or **Review bridge update** action (VPS) to receive the new catalog.
In n8n's OpenAI node, choose **Image**, then **Generate an Image** or **Edit Image**.
Select `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` from the model list; use
**By ID** if your n8n version does not list it. `gpt-image-2` remains available.
The generic `gpt-image-2.5` name is not a request ID. Start with low quality;
exact output dimensions and every image option are not verified. Model discovery
does not guarantee access for every account. Image models are separate from
text chat, GPT-Live, Realtime, and audio support.

**Current ChatGPT bridge limits.** OpenAI audio/TTS, transcription, and
translation are unavailable through Relmio's current ChatGPT sign-in bridge in
both local and VPS n8n. The OpenAI Audio API requires a separate API-key
connection. Do not enter that API key into this OAuth bridge; refreshing your
ChatGPT sign-in will not add audio support.

The current bridge also does not support n8n's **Classify Text for Violations**
action (Moderation API), file upload/list/delete, stored conversation
create/get/update/delete, or video generation. See the full
[n8n capability table](docs/n8n-configuration.md#3-openai-node-v2-capability-audit).

Relmio does not edit, restart, rebuild, or expose n8n. The bridge is unofficial,
private, experimental, and policy-uncertain. Check the rules that apply to your
account before using it.

**Credential and data path.** The local bridge copies the complete ChatGPT/Codex
credential JSON into a private named Docker volume for the third-party pinned
`openai-oauth` package. The VPS bridge transfers the same file by SFTP to the
deployment's `auth` bind mount. n8n sends supported prompts, messages, tool
data, and inline inputs through that package to OpenAI. Building the sidecar
contacts the npm registry to install the pinned package. The one-shot local
credential-seed helper disables Docker logging; the main sidecar has no
explicit Docker log-driver setting. Do not treat any of this as a supported
Sign in with ChatGPT integration, scope grant, Platform API permission, Terms
approval, or model/TTS entitlement.

[Read the existing n8n guide](https://relmio.jpfusin.tech/docs/local-endpoints#self-hosted-n8n-bridge)

For SuperGrok, choose **SuperGrok for n8n**, select
its container and network, then review the private installation. Copy the
one-time Relmio client credential and use `http://n8n-supergrok:14502/v1`.
`grok-build` remains a legacy routing alias; use a freshly discovered model
where the n8n control supports it. Then run:

```sh
relmio grok login --n8n
```

Approve the official device sign-in. The credential entered in n8n's API key
field authorizes access to Relmio only; it is not an xAI API key. For workflow
model nodes, turn **Use Responses API** off and choose **From list**. For Chat
Hub, turn it off in **Settings > Chat > OpenAI > Edit provider**. The Assistant
custom endpoint uses a discovered model name in its text field; it is separate
from the Chat setting. An earlier development install without the fresh-session
marker is not upgraded automatically; migration requires a separately reviewed
path. Sign out with `relmio grok logout --n8n`. This
companion publishes no host port.
### I want a provider-free model for n8n
First use does not require an existing `.relmio` directory. To opt in to the
experimental local-model workflow, open the dashboard with
`npx --yes --ignore-scripts relmio@0.18.0-experimental.4 local`;
it initializes dashboard state as needed. The local-model installation
requires an existing running n8n container and does not install n8n. If you do
not yet run local n8n, set it up separately before selecting a model.

Choose **Local model for n8n** to install one CPU-based Ollama model beside an
existing local n8n container, or use the dedicated VPS model setup route. The
wizard measures Docker-visible memory, CPU, and disk, lets you select from the
allowlisted model catalog, and reviews the exact resources and download before
you confirm. The runtime uses the selected existing Docker network and
publishes no host port. It needs no ChatGPT sign-in, OAuth credential, or
provider API key.

The model API has no authentication: all containers on the selected network
are trusted. Ollama cloud features are disabled, but first-time image and model
downloads still require internet access. n8n uses the private base URL and an
ignored placeholder key; see the [local-model guide](docs/local-models.md) for
capacity estimates, setup, configuration, retry, and explicit cache removal.
This is a workflow Chat Model, not n8n AI Assistant sandbox setup or proof of
reliable tool calling.

Prior private-candidate checks covered model-only smoke scenarios in local
Docker and on a Hostinger VPS; they do not establish this `.2` artifact,
full-stack behavior, support on other providers, model quality, or throughput.
Cold model loads and host pressure may exceed caller deadlines; a reported
120-second local inference timeout is not fixed by the Docker-attestation
changes in this prerelease.

For **Local model · your VPS**, the hosting selector provides guidance for
15 Linux VM presets; see [Hosting compatibility](docs/hosting-compatibility.md)
for login hints, managed prerequisites, manual platform routes, and
provider-specific limits.
Use the actual image/administrator username and **Local SSH agent**
or approved password; verify the host fingerprint before authentication.
The host needs rootful Docker Engine, Compose v2 and Buildx build tooling with
its existing `default` Docker context targeting the local n8n daemon, existing
n8n on an eligible bridge, measured capacity and a safe root-owned `/docker`.
Relmio does not provision the VM, install Docker/n8n, or change SSH policy.
Final review also discloses temporary root-only Buildx state inside the owned
operation lock. Verified cleanup removes only that state; uncertain cleanup
retains the lock for administrator inspection, never automatic n8n/cache deletion.

Verified **Passwordless sudo -n (model only)** supports this model flow, not
OAuth bridge, AI Assistant or SuperGrok VPS operations; those retain their
existing approved direct-root requirement. Agent keys stay local, and a
persistent dashboard must be launched from the correct agent environment.
Render service SSH is unsupported by the managed installer, but a separate
paid private model service is a manual option with its own disk and internal
DNS. See [Hosting compatibility](docs/hosting-compatibility.md) for all managed
and manual routes, image-qualified usernames, agent setup and provider limits.


### I do not have n8n yet

Choose **Set up new n8n**. Relmio creates a separate n8n stack and walks
you through the ngrok domain, token, and Basic Auth fields. Only the new n8n
route is public. Its model bridge, Code Sandbox, and optional SearXNG stay off
the host network.

[Read the new n8n guide](https://relmio.jpfusin.tech/docs/local-n8n-stack)

### I want to use SuperGrok

The experimental **SuperGrok** adapter uses official OAuth with your eligible
subscription. Local apps and n8n use `/v1/chat/completions` and a separate
local Relmio bearer. The current account catalog listed `grok-4.6` and
`grok-4.5`; discovery is not per-model tool proof. Explicit `grok-4.6` passed
the n8n Assistant node-catalog tool and a Calculator workflow (`317 × 29 =
9193`). `grok-build` remains a legacy alias, not a claim that every request
uses Grok 4.6. Existing n8n is never reconfigured or restarted by this setup.
No xAI API key is requested.

After installing the local SuperGrok endpoint, sign in:

```sh
relmio grok login
```

Approve the displayed code on the official provider page. To sign out later,
run `relmio grok logout`. These commands act only on the attested Relmio runtime.

[Read the SuperGrok guide](https://relmio.jpfusin.tech/docs/local-endpoints#supergrok-development-backends)

## n8n AI Assistant tools

Choose **n8n AI Assistant tools** in the local browser wizard to add Code
Sandbox beside an existing n8n container. SearXNG web search is optional and
off by default. Relmio shows the sandbox key and n8n settings once. It does not
change or restart n8n.

Configure the Assistant's supported model connection directly in n8n. The privileged local runner is for
development and testing; n8n recommends Daytona for production.

[Read the AI Assistant guide](https://relmio.jpfusin.tech/docs/ai-assistant)

## Codex device sign-in

The **Codex App Server** and **Codex Chat Adapter** options use the official
Codex device-code sign-in. The ChatGPT credential stays inside the isolated
Codex container. These experimental routes are for trusted local apps and
development backends, not browsers or public servers.

## Provider account policy

Relmio's Codex targets use the official Codex App Server. Codex owns the
ChatGPT OAuth flow, credential storage, and refresh. Each target has one active
ChatGPT account; changing it requires an explicit sign-out and new sign-in.

Relmio 0.15.0 does not configure upstream API keys, maintain API-key profiles,
or fall back to separately billed API access.

The experimental SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Local apps use `/v1/chat/completions` with a separate Relmio client bearer.
`grok-build` is a supported legacy routing alias; a fresh authenticated catalog
can provide current routing names, but a listing does not prove a model's tool
behavior. n8n executes its own tools and returns matching results. The legacy
simple `/chat` request shape remains available through the direct transport.
Browser bundles must not hold the local bearer or call it directly.


Relmio never changes accounts automatically after a 401, 403, or 429,
rate-limit, or quota response. Future provider authentication is denied by
default until the provider documents a supported method and Relmio adds a
reviewed implementation. The dashboard may report that a credential is
configured, but it never returns or re-shows a stored secret.

## Sign-in lifetime

ChatGPT/Codex sign-in tokens expire. The official Codex client refreshes them
automatically during active use before they expire, so active sessions usually
continue without another browser login. Official OpenAI documentation does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Common problems

- **Docker is not running.** Start Docker Desktop or Docker Engine, then open a
  fresh wizard session.
- **Authentication fails.** Close old sign-in tabs, run `relmio open`, and use
  the private page opened by the active dashboard process.
- **Local image build failed.** Check Docker, disk space, and registry access.
- **Git Bash says stdin or stdout is not a TTY.** Use the hosted curl launcher,
  which applies the bundled `winpty` bridge. For direct NPX on Git Bash 2.38.1,
  prefix that process with `MSYS=enable_pcon`. Do not add a global Git setting.

[Open troubleshooting](https://relmio.jpfusin.tech/docs/troubleshooting)

## Guides

- [Getting started](https://relmio.jpfusin.tech/docs/getting-started)
- [Local endpoints and n8n bridge](https://relmio.jpfusin.tech/docs/local-endpoints)
- [New local n8n + ngrok](https://relmio.jpfusin.tech/docs/local-n8n-stack)
- [VPS and n8n](https://relmio.jpfusin.tech/docs/vps-and-n8n)
- [SuperGrok on a VPS](https://relmio.jpfusin.tech/docs/vps-supergrok)
- [n8n AI Assistant](https://relmio.jpfusin.tech/docs/ai-assistant)
- [Security and policy notes](https://relmio.jpfusin.tech/docs/security)
- [Private local models](https://relmio.jpfusin.tech/docs/local-models)
- [Hosting compatibility](https://relmio.jpfusin.tech/docs/hosting-compatibility)
- [Reference](https://relmio.jpfusin.tech/docs/reference)
- [Changelog](https://relmio.jpfusin.tech/changelog)

## Support

Relmio is free to use. If it helped you, you can buy me a coffee.

<a href="https://ko-fi.com/paldogies" target="_blank" rel="noopener noreferrer"><img height="36" src="https://storage.ko-fi.com/cdn/kofi6.png?v=6" alt="Support Relmio on Ko-fi"></a>

## Legal

Relmio is an unofficial, community-maintained project. It is not affiliated
with, endorsed by, or sponsored by OpenAI.

Treat ChatGPT/Codex credentials like passwords. Use only your own account. Do
not pool, share, forward, or sell access tokens. Any request made with those
credentials must be authorized by the account owner.

You are responsible for following OpenAI's [Terms of Use](https://openai.com/policies/terms-of-use/),
[Usage Policies](https://openai.com/policies/usage-policies/), and any other
agreement that applies to your account.

> [!WARNING]
> **Do not bypass rate limits, restrictions, or safeguards.**

Relmio is provided as-is without warranties. OpenAI or an upstream service may
change or discontinue access at any time. You accept the risks of using this
experimental community project.
