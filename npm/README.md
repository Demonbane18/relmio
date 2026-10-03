<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/relmio@latest/docs/images/brand/relmio-banner-animated.svg" alt="Animated Relmio mascot carrying a private n8n connection through its doorway" width="1200">
</p>

<h1 align="center">Relmio</h1>

<p align="center"><strong>Bring your AI sign-ins to your tools. Keep every credential where it belongs.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm version" src="https://img.shields.io/npm/v/relmio?logo=npm&amp;color=0f8f83"></a>
  <a href="https://www.npmjs.com/package/relmio"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/relmio?color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Demonbane18/relmio?style=flat&amp;logo=github&amp;color=0f8f83"></a>
  <a href="https://github.com/Demonbane18/relmio/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/Demonbane18/relmio/ci.yml?branch=main&amp;label=CI"></a>
  <a href="https://github.com/Demonbane18/relmio/blob/main/LICENSE"><img alt="Apache 2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0f8f83"></a>
</p>

Managed provider OAuth stays in its private runtime, except for the existing
n8n OpenAI bridge: it starts Codex sign-in on the host and copies the complete
credential JSON into its selected private sidecar after confirmation. API-key
connections and operator-generated hosting artifacts are configured separately
in n8n or the target platform. ChatGPT sign-in is not an OpenAI Platform API key.
SuperGrok setup does not require or read ChatGPT/Codex credentials.
The hosted chat demo on the website is turned off while Relmio applies to
OpenAI for access. ChatGPT sign-in now works only in the local wizard. See the
[hosted chat security notes](https://relmio.jpfusin.tech/docs/security#hosted-chat-demo).

Relmio 0.18.5 is the current stable release. The redesigned five-step wizard
is available through npm `latest` and the hosted installers.

See the [full GitHub guide](https://github.com/Demonbane18/relmio/blob/main/README.md), the [2026-09-29 source review and wizard consent correction](https://github.com/Demonbane18/relmio/blob/main/docs/openai-source-check-2026-09-29.md), the [2026-09-28 source review follow-up](https://relmio.jpfusin.tech/docs/security#2026-09-28-private-candidate-openai-source-check), and the historical [2026-09-27 source review](https://relmio.jpfusin.tech/docs/security#2026-09-27-openai-and-hosting-source-review).


The browser wizard's **Test AI Chat** console keeps partial response text
visible while it streams. Its status distinguishes connection setup, waiting
for the first words, active streaming, completion, interruption, and failure
without announcing every token to assistive technology. **Stop response**
preserves text already received, and reduced-motion preferences keep the same
state cues without animation. This presentation does not change the Chat
Adapter protocol or external clients such as n8n.

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
This command selects stable Relmio 0.18.5, including the redesigned chooser.
Hosted installers use the same stable default.


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

No Node.js yet? The [hosted install guide](https://relmio.jpfusin.tech/install)
has native curl, Homebrew, PowerShell, and Command Prompt options. Homebrew
installs the persistent `relmio` command; it does not launch the browser. The
curl, PowerShell, and Command Prompt launchers open the foreground wizard with
the same platform security checks.

## Dashboard commands

Install a persistent command, then manage only Relmio's owner-scoped loopback
dashboard process:

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

`relmio stop` stops only that process. These commands do not stop or restart
n8n, ngrok, model endpoints, bridges, Assistant companions, or unrelated
containers. Hosted launchers remain a foreground, one-shot process when they
use a verified temporary runtime.

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
bridge runtime. See the
[maintenance guide](https://github.com/Demonbane18/relmio/blob/main/docs/maintenance.md)
for the full update and rollback boundaries.

**Refresh status** rediscovers eight services: Codex App Server, Codex Chat
Adapter, Grok Build, the owned n8n stack, the ChatGPT OAuth bridge, AI Assistant
tools, SuperGrok for n8n, and the local model for n8n. It shows only verified
connection URLs and state, never stored secrets. Select **Add connection** for
the existing four-step setup flow. Bare `relmio` and `relmio vps` open VPS setup;
use `relmio local` for this computer's setup route.

Choose **Set up SuperGrok for n8n** in the VPS wizard to add the same private
Grok OAuth companion to an existing remote n8n. Review the exact plan before
installation, then complete official device sign-in in your browser. See
[SuperGrok on a VPS](https://relmio.jpfusin.tech/docs/vps-supergrok) for Chat
Completions settings and ownership-safe management. No existing n8n restart or
provider change is required.

[Learn how to use the local dashboard](https://github.com/Demonbane18/relmio/blob/main/docs/local-dashboard.md)

## Pick a path

### Review hosting and integration plans

Use **Hosting options** in the authenticated wizard to compare existing managed
local/VM setup with operator-applied artifacts. The catalog includes 15 Linux
VM presets plus local Docker, manual private platform recipes, 15 self-hosted
n8n Daytona configuration handoffs, authenticated endpoint handoffs and
restricted edge relays. Review the validated settings, steps, requirements,
limits and source links; download the complete ZIP to preserve nested paths or
individual files.

Plan generation contacts no provider account or host, provisions nothing, and
does not apply files or edit/restart n8n. Do not enter secrets; supply them
separately through provider secret facilities. New provider runtime acceptance
is **NOT-RUN**; a manual artifact is not a managed SSH installation. Read the
[full hosting compatibility guide](https://relmio.jpfusin.tech/docs/hosting-compatibility)
and [AI Assistant guide](https://relmio.jpfusin.tech/docs/ai-assistant).

The endpoint routes for n8n Cloud, Vercel, Netlify and Cloudflare Workers are
authenticated HTTP integrations, not general URL relays or native n8n
adapters. Cloudflare Container SearXNG requires an authenticated Worker and an
n8n HTTP Request tool; its custom bearer is not a native Assistant SearXNG
integration. Vercel/Railway/Cloudflare Sandbox SDKs are not native n8n sandbox
providers.

Relmio classifies the OpenAI bridge as a stable workflow. It remains
unofficial, private, and policy-uncertain. OpenAI documents identity sign-in and
separately authorized ChatGPT plan usage; those documents do not establish
approval for Relmio's Codex credential-copy bridge. See the
[dated source-check, data flow and unknowns](https://relmio.jpfusin.tech/docs/security#2026-09-26-openai-source-check).


### Existing n8n model bridge

Choose **ChatGPT for n8n** or **Grok for n8n** in the local wizard. Specialist
Codex and Assistant tools remain under **More connections and tools**.

Choose the provider connection or local model that fits your workflow. The
Responses API switch is specific to each integration:

| Connection | Base URL | n8n API-key field | Use Responses API |
| --- | --- | --- | --- |
| OpenAI OAuth with ChatGPT/Codex sign-in | `http://n8n-openai-oauth:10531/v1` | `local-only` placeholder | **On** in the Relmio OpenAI Chat Model v1.3 recipe |
| SuperGrok OAuth | `http://n8n-supergrok:14502/v1` | One-time local Relmio bearer | **Off** for workflow model nodes and Chat Hub |
| Local Ollama model for n8n | `http://n8n-local-model:11434/v1` | `local-only` ignored placeholder | **Off** for Chat Completions |

First use does not require an existing `.relmio` directory. Open the dashboard
with `npx --yes --ignore-scripts relmio@latest local`; it initializes dashboard
state as needed. The local-model option requires an existing running n8n
container and does not install n8n. If you do not yet run local n8n, set it up
separately before selecting a model.

For a provider-free model, choose **Local model for n8n** and review the
measured Docker resources and expected download. The unauthenticated model API
is private to the selected trusted Docker network and has no published host
port. Ollama cloud features are disabled, but image/model downloads need
internet access. See the
[local-model guide](https://github.com/Demonbane18/relmio/blob/main/docs/local-models.md)
for local/VPS setup, capacity estimates, n8n settings, retry, and explicit
cache removal. This workflow Chat Model is separate from Assistant sandbox
setup and does not establish reliable tool calling.

Model-only smoke checks covered local Docker and a Hostinger VPS. Linux
full-stack acceptance is tracked in
[issue #86](https://github.com/Demonbane18/relmio/issues/86). A reported
120-second local inference timeout on cold model loads remains open. Cold loads
and host pressure can exceed caller deadlines, and CPU inference can be slow.
These checks prove bounded inference only, not a working workflow, tool calling,
model quality, throughput, or support on other hosts.

Relmio's VPS model setup is tested on Hostinger KVM VPS. Other Linux VPS hosts,
including Hetzner, and all hosting-plan platforms are experimental. See the
[full hosting compatibility guide](https://relmio.jpfusin.tech/docs/hosting-compatibility)
for account guidance, managed prerequisites, manual platform routes, and
provider limits.


The **Local model · your VPS** route provides guidance for 15 Linux VM presets.
Use your actual SSH account with an existing local agent or approved password,
verify the host fingerprint, then review the plan. It requires rootful Docker
Engine, Compose v2 and Buildx build tooling with its existing `default` context
targeting the local n8n daemon, an eligible bridge, measured capacity and a safe
preexisting root-owned `/docker`. Relmio does not provision the host, install
Docker/n8n or change SSH policy. Review includes temporary root-only Buildx state
inside the owned operation lock. Verified cleanup removes only that state;
uncertainty retains the lock for administrator inspection, never automatic
n8n/cache deletion.

Verified **Passwordless sudo -n (model only)** does not extend to OAuth bridge,
AI Assistant or SuperGrok VPS operations; those require existing approved
direct-root access. Keep keys local and launch the dashboard from its agent
environment. Render service SSH is unsupported by the managed installer; a
separate paid private model service with its own disk/internal DNS is a manual
option. See [Hosting compatibility](https://relmio.jpfusin.tech/docs/hosting-compatibility)
for managed and manual routes, login hints, agent setup, and provider limits.

The VPS wizard has five steps: **Choose setup**, **Check server**, **Choose
n8n**, **Review**, and **Ready**. Choose the ChatGPT route before signing in.
Enter the server address and port, independently compare and confirm its SSH
fingerprint, then enter the username and choose authentication. After
connecting, select the n8n container and private Docker network. Review names
the currently verified SSH identity as the recipient of the complete
ChatGPT/Codex credential file. Going back or changing the connection clears the
plan and approval; confirm separately before any remote write. Configure n8n
with:


```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: local-only
Responses API: On
```

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
[n8n capability table](https://github.com/Demonbane18/relmio/blob/main/docs/n8n-configuration.md#3-openai-node-v2-capability-audit).

Relmio does not edit or restart n8n. The bridge is unofficial, private,
and policy-uncertain.

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

### New local n8n + ngrok

Choose **Set up new n8n** in the local wizard.

Create a separate n8n stack when you do not have one yet. The wizard explains
the ngrok domain, token, and Basic Auth fields. Only the new n8n route is
public. Private model and Assistant services keep their host ports closed.

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
Sandbox. SearXNG web search is optional and off by default. Relmio shows the
sandbox key and n8n settings once. It does not change or restart n8n.

Enter your supported model credential directly in n8n. The privileged local
runner is for development and testing; n8n recommends Daytona for production.

## Codex device sign-in

The experimental Codex options use the official device-code sign-in. The
ChatGPT credential stays inside the isolated Codex container. Use these routes
only with trusted local apps or development backends.

## Provider account policy

Relmio uses the official Codex App Server, and Codex owns the ChatGPT OAuth
flow, storage, and refresh. Each Codex target has one active ChatGPT account;
switching requires explicit sign-out and sign-in.

Managed ChatGPT/Codex and SuperGrok OAuth sign-in flows do not configure
upstream API keys, keep API-key profiles, or fall back to separately billed API
access. Configure API-key connections and operator-generated hosting artifacts
separately in n8n or on the target platform. Retired API installations and
their data remain untouched.

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
default. The dashboard never returns or re-shows a stored secret.

## Sign-in lifetime

The Codex authentication guide describes automatic credential refresh but does
not give a fixed token lifetime. Relmio's private bridge refreshes its own
credential copy. OpenAI's one-hour access-token and rotating 30-day
refresh-token lifetimes describe the separate Sign in with ChatGPT plan-usage
flow, not Relmio's pinned Codex flow. The local capability remains valid until
you rotate it.

## Common problems

- **Docker is not running.** Start Docker, then open a fresh wizard session.
- **Authentication fails.** Close old sign-in tabs and run `relmio open` to
  open the active private dashboard page.
- **Local image build failed.** Check Docker, disk space, and registry access.
- **Git Bash says stdin or stdout is not a TTY.** Use the hosted curl launcher,
  which applies the bundled `winpty` bridge. For direct NPX on Git Bash 2.38.1,
  prefix that process with `MSYS=enable_pcon`. Do not add a global Git setting.

## Guides

- https://relmio.jpfusin.tech/install
- https://relmio.jpfusin.tech/docs/getting-started
- https://relmio.jpfusin.tech/docs/local-endpoints
- https://relmio.jpfusin.tech/docs/local-n8n-stack
- https://relmio.jpfusin.tech/docs/vps-supergrok
- https://relmio.jpfusin.tech/docs/local-models
- https://relmio.jpfusin.tech/docs/hosting-compatibility
- https://relmio.jpfusin.tech/docs/ai-assistant
- https://relmio.jpfusin.tech/docs/troubleshooting
- https://relmio.jpfusin.tech/docs/security
- https://relmio.jpfusin.tech/changelog

## Support

Relmio is free to use. If it helped you, you can buy me a coffee.

<a href="https://ko-fi.com/paldogies" target="_blank" rel="noopener noreferrer"><img height="36" src="https://storage.ko-fi.com/cdn/kofi6.png?v=6" alt="Support Relmio on Ko-fi"></a>

Source and issues: https://github.com/Demonbane18/relmio

License: Apache-2.0
