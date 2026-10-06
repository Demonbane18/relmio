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

Use ChatGPT plan sign-in from the local wizard for self-hosted connections.
Identity, separately granted plan permission, and model/request access are
distinct. A ChatGPT sign-in is not an OpenAI Platform API key, and Relmio does
not import a personal Codex login. SuperGrok uses its own session.

The website's `/api/chat` remains off and returns `410 Gone`; local setup does
not enable hosted chat. See the
[full GitHub guide](https://github.com/Demonbane18/relmio/blob/main/README.md)
and the
[2026-10-05 OpenAI source check](https://github.com/Demonbane18/relmio/blob/main/docs/openai-source-check-2026-10-05.md)
for setup, data handling, limits, and unresolved prerequisites.

The local wizard's **Test AI Chat** console keeps partial response text visible
while it streams. Status distinguishes connection setup, waiting for the first
words, active streaming, completion, interruption, and failure without
announcing every token to assistive technology. **Stop response** preserves
text already received, and reduced-motion preferences keep the same state cues
without animation. This does not change external clients such as n8n.

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
This command selects stable Relmio 0.18.6, including the redesigned chooser.
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

## Install and update

### Existing ChatGPT and sidecar installations

Installing a newer Relmio package updates the wizard, not an already-running
sidecar. Use the current ownership-attested action for the exact target and
review its plan; see the
[maintenance guide](https://github.com/Demonbane18/relmio/blob/main/docs/maintenance.md).
For an installed VPS ChatGPT sidecar, that action is **Review sidecar update**
under **Manage the installed ChatGPT session**. It rebuilds only the sidecar
and keeps the ChatGPT sign-in and the one-time key; see
[Update the installed sidecar](https://github.com/Demonbane18/relmio/blob/main/docs/vps-and-n8n.md#update-the-installed-sidecar).
Relmio leaves retired API-key gateways and their credential volumes untouched.

Older credential-copy ChatGPT bridges are not silently adopted. A reviewed
local migration uses a fresh SIWC registration and separate migration consent.
Relmio stops only the attested old service after final confirmation and keeps
credential/workspace volumes offline; it never copies the old `auth.json` to
the new runtime. If the outcome is uncertain, the old service is not resumed
automatically; inspect the retained resources.

The documented local OSS flow needs no commercial approval, partner-issued
client, or secret. The user still separately grants ChatGPT plan use and
confirms the first-use notice. The VPS guide and SIWC Terms do not resolve
persistent remote token storage; the implementation makes no provider-approval
claim for VPS use. The Terms' connected-application rule may also conflict
with an OpenAI-compatible endpoint for n8n, and Relmio is not in OpenAI's
partner directory. Both questions are open. Read the
[VPS guide](https://relmio.jpfusin.tech/docs/vps-and-n8n) and
[2026-10-05 source check](https://github.com/Demonbane18/relmio/blob/main/docs/openai-source-check-2026-10-05.md).

Relmio also refuses to adopt an earlier SuperGrok development install that
lacks its fresh-session marker. Review that installation separately before
removal or migration.

**Refresh status** shows eight services: Codex App Server, Codex Chat Adapter,
Grok Build, the owned n8n stack, the ChatGPT plan sidecar, AI Assistant tools,
SuperGrok for n8n, and the local model for n8n. It shows only verified
connection URLs and state, never stored secrets. Select **Add connection** for
the setup flow. Bare `relmio` and `relmio vps` open VPS setup; use `relmio
local` for this computer's setup route.


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

The hosting catalog generates operator-applied plans; it grants no OpenAI
permission or model entitlement. The local ChatGPT plan sidecar is separate
from the website, whose `/api/chat` returns `410 Gone`. The
[2026-10-05 source check](https://github.com/Demonbane18/relmio/blob/main/docs/openai-source-check-2026-10-05.md)
records current local behavior and unresolved hosted/VM requirements.


### Existing n8n model bridge

Choose **ChatGPT for n8n** or **Grok for n8n** in the local wizard. Specialist
Codex and Assistant tools remain under **More connections and tools**.

Choose the provider connection or local model that fits your workflow. The
Responses API switch is specific to each integration:

| Connection | Base URL | n8n API-key field | Use Responses API |
| --- | --- | --- | --- |
| OpenAI plan use | `http://n8n-openai-oauth:10531/v1` | One-time local Relmio bearer | **On** in OpenAI Chat Model node version 1.3 |
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

The VPS wizard signs in locally before you select the server and n8n target.
It confirms the SSH host fingerprint before authentication. Before final write
confirmation it shows the verified server identity, the exact plan, and short
IDs for the reviewed n8n container and network. Relmio checks those exact IDs
again before it writes and before it transfers the session; a changed ID stops
the install and asks for a new review. After the install completes, status and
sign-out need only the same SSH host and Docker network, so they keep working
if n8n is recreated or you change the SSH login method. The destination
receives one selected registration and becomes its only refresh owner. If
transfer completion cannot be confirmed, the session stays frozen until you
inspect the destination. Relmio does not restore the sender's old tokens or
restart an old writer automatically.

If SSH connects but the read-only Docker or n8n check fails, the wizard keeps
the verified connection and offers **Retry discovery** without asking for the
password again. Changing the server details requires a fresh identity check.

If a local or VPS install stops partway, status shows it as staged. Select the
account, then review and confirm the resume in the wizard. It continues the
same installation without deleting data or starting a second refresh writer;
if the session had already moved, the one-time key is replaced. Turning plan
use on or off, or a token refresh, before you resume does not block it. If the
destination accepted the session but the acknowledgment was lost, review and
confirm a reconcile. Relmio reads the destination's receipt and finishes the
handoff. Without a receipt, the sender stays frozen and needs a fresh sign-in;
old tokens are never restored. A different account can take over only after a
confirmed "not accepted" result. Relmio refuses if the original receipt
appears, and on a VPS also while a one-off helper container is still present.
If ownership moved but a later finishing step failed, the result still shows
the one-time key once, with a warning not to use it until the reported issue
is resolved.

The local or VPS sidecar is available only to containers on the selected
private Docker network and publishes no host port. n8n does not receive the
provider token. Enter the one-time Relmio bearer from the result screen
manually in n8n:

```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: <one-time Relmio bearer shown by the wizard>
Use Responses API: On
```

The sidecar lists the selected account's text models. OpenAI filters its
catalog by an undocumented `client_version` parameter, so the sidecar asks as
the newest stable Codex release on npm, never below Relmio's pin (0.160.0). It
checks npm about every 12 hours, when n8n next asks for models. That
request sends no credentials; `registry.npmjs.org` sees the sidecar host's IP
address. The catalog is cached for 5 minutes. Local Codex clients and the
wizard's pre-install account picker still use the pin.

On a VPS, **Check installed account** also shows a Models group: each model
says **In n8n** or **Not in n8n** and has **Copy ID**. Optional model checks
send one short test request per new model, use a little of your plan, and
need your confirmation. They are off by default. See
[model discovery and checks](https://github.com/Demonbane18/relmio/blob/main/docs/n8n-configuration.md#model-discovery-and-checks).

Relmio sends supported requests to `/v1/responses`. The
`/v1/chat/completions` compatibility route translates text messages and
function tools into a Responses request. Function tools go upstream in one
`additional_tools` item, and n8n runs the tools itself. The route allows up to
32 tool calls, 128 KiB of arguments per call, and 2 MiB of streamed arguments
in total. It rejects a named `tool_choice`, tool namespaces, custom tools in
streamed requests, system messages, and inputs it cannot preserve. Chat
clients receive only final-answer text; reasoning items and intermediate
commentary are not passed on. The Responses route passes OpenAI's events
through unchanged, except failure events, which it rewrites with a safe
error. On 2026-10-05 a two-turn LangChain tool test passed through the real
gateway on one ChatGPT account, streaming over both routes. That is not a
guarantee for other accounts or models. Audio, video, Files routes, stored
conversations, moderation, the Responses `image_generation` tool, and
unsupported parameters are rejected without a fallback. The exception is an
output-token cap (`max_output_tokens`, or `max_completion_tokens` and
`max_tokens` on the chat route). SIWC doesn't accept one, so the sidecar
drops it and the cap is not enforced.

On a VPS you can turn on image generation and editing as an opt-in add-on. In
**Manage the installed ChatGPT session**, choose **Check installed account**,
then **Sign in for images**, and enter the code at
`https://auth.openai.com/codex/device`. In n8n, use the OpenAI node's
**Image** actions with the same Base URL and Relmio key, and pick
`gpt-image-2` from the list or enter it as the ID. The add-on uses a separate
Codex sign-in, the way Hermes
Agent does. OpenAI does not document this route for other apps, so it can stop
working without notice. Images count against your plan's Codex limits, and the
Codex refresh token is stored on the VPS. The ChatGPT plan session is never
used for images. Each request returns one image; masks and URL responses are
not supported. The local sidecar has no image sign-in. See
[Turn on image generation](https://github.com/Demonbane18/relmio/blob/main/docs/vps-and-n8n.md#turn-on-image-generation-optional)
for limits and sign-out.

The OpenAI Chat Model node (v1.2 and newer) and Chat Hub do not list
`gpt-image-2`. The OpenAI node's text picker still does, because it shares one
model request with the image picker; use that ID only for images. A 2026-10-06
test showed the Codex image route ignores the model ID, so GPT Image 2.5 Flare
and Sunburst need a separate OpenAI credential with your own Platform API key
on n8n's image node. See
[image limits and test evidence](https://github.com/Demonbane18/relmio/blob/main/docs/n8n-configuration.md#generate-and-edit-images-vps-add-on).

n8n's AI Assistant cannot list sidecar models. To try one, choose
**Self-hosted or OpenAI-compatible endpoint** under
**Settings > n8n Assistant > Model**, use the same Base URL and Relmio key,
and paste a model ID. Only do this if nobody else uses this n8n: their
Assistant chats would use your ChatGPT plan. The sidecar keeps the
Assistant's earlier reasoning and replies in memory only, for up to 6 hours;
after a sidecar restart or update, start a new Assistant conversation. Relmio
has not completed a live Assistant test with this sidecar, and OpenAI has not
said whether this use fits its Sign in with ChatGPT terms. See
[Assistant setup](https://github.com/Demonbane18/relmio/blob/main/docs/ai-assistant.md#optional-chatgpt-plan-sidecar-untested).

Installing for n8n also requires express consent for background workflows.
Relmio does not edit n8n's credentials or Compose configuration. Existing
legacy bridge installations require a separately reviewed migration and a
fresh SIWC sign-in. The published SIWC Terms and VM guide do not resolve
persistent remote VM token storage; the VPS implementation is not presented as
provider-approved. Read the
[VPS guide](https://relmio.jpfusin.tech/docs/vps-and-n8n) and
[source check](https://github.com/Demonbane18/relmio/blob/main/docs/openai-source-check-2026-10-05.md).

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

## Codex App Server and Chat Adapter

The local **Codex App Server** keeps its WebSocket protocol and relays to the
official Codex App Server over stdio with the selected SIWC access token and
public Responses provider. It is a high-trust target for a native client owned
by the same account holder, not a browser or general `/v1` service. The relay
forwards every client JSON-RPC call except a short deny-list to the official
App Server, which runs as the same user that owns the SIWC store. Connect only
trusted local clients. Agent spawning and deferred `tool_search` are disabled;
unsupported account/auth, connector, marketplace, plugin, and configuration
mutations are rejected. This is not full App Server feature parity.

The separate **Codex Chat Adapter** is a narrower, read-only conversational
HTTP contract for trusted local backends.

Direct WebSocket connections close shortly before token expiry. Reconnect and
explicitly resume a known account-bound thread; its record survives relay
restarts. Unknown or foreign threads are rejected, and interrupted turns are
not replayed.

## Provider account policy

Each registration is bound to a verified issuer, issued client ID, and subject.
Email is a display label; matching addresses do not merge accounts. Sign-in,
ChatGPT plan permission, and successful model requests are separate states.
Relmio does not switch registrations or use Platform API billing after an error.
Sign-out clears local tokens and attempts provider revocation. If revocation
cannot be confirmed, follow the wizard's ChatGPT disconnection guidance.

Managed ChatGPT plan use does not configure an OpenAI Platform API key or fall
back to separately billed API access. Configure unrelated API-key connections
and operator-generated hosting artifacts separately in n8n or the target
platform. Retired API installations and their data remain untouched.

The experimental SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Local apps use `/v1/chat/completions` with a separate Relmio client bearer.
`grok-build` is a supported legacy routing alias; a fresh authenticated catalog
can provide current routing names, but a listing does not prove a model's tool
behavior. n8n executes its own tools and returns matching results. Browser
bundles must not hold the local bearer or call it directly.

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
