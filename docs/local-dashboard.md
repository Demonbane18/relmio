# Use the local dashboard

After you start Relmio, the local dashboard rediscovers the services Relmio
manages on this computer and lists their verified connection URLs. You can copy
those URLs, open a reviewed maintenance action, or start the existing setup
wizard.

An installed Relmio command can keep this dashboard running in the background.
It does not install an operating-system login service or start at login.

## Start the dashboard

Install the published command with Node.js 24 or newer:

```bash
npm install --global --ignore-scripts relmio@latest
```

Then start and open the dashboard:

```bash
relmio start
relmio open
```

You can also run the published package without a global install:

```bash
npx --yes --ignore-scripts relmio@latest
```

That command opens the **ChatGPT on my server** route in a foreground setup
wizard without creating persistent dashboard state. It is safe to use on a
first-run machine with no Relmio files and no local n8n stack; prerequisite
checks and actionable errors appear inside the browser wizard. Because NPX does
not place `relmio` on your PATH, repeat the full command and add an explicit
lifecycle action when you want a persistent dashboard:

```bash
npx --yes --ignore-scripts relmio@latest start
npx --yes --ignore-scripts relmio@latest status
npx --yes --ignore-scripts relmio@latest open
npx --yes --ignore-scripts relmio@latest stop
```

From a repository checkout with dependencies installed, run:

```bash
npm start
```

This uses the same foreground, first-run wizard behavior as the bare NPX
command. It does not initialize the persistent local dashboard before opening
the browser.

Use the [hosted install page](https://relmio.jpfusin.tech/install) when you need
the native macOS, Linux, PowerShell, or Command Prompt launcher. A hosted
launcher can use a verified temporary Node.js runtime, so it deliberately runs
Relmio as a foreground, one-shot process and removes that runtime afterward.
It does not install a persistent command. Do not run `relmio assistant` for
this page. That command opens the separate Assistant-only wizard.

Bare `relmio` and `relmio vps` open the VPS setup directly. Run `relmio local`
to open the setup route for this computer.

Relmio binds the dashboard only to `127.0.0.1`. To open it, Relmio creates an
owner-only, short-lived handoff file and exchanges its one-time capability for
the active tab session. Neither the browser-launch command nor the visible
dashboard URL contains that capability.

## Manage the dashboard process

| Command | Result |
| --- | --- |
| `relmio start` | Start the owner-scoped loopback dashboard in the background without opening a browser |
| `relmio status` | Verify and report the exact dashboard process without printing its private session value |
| `relmio open` | Start the dashboard when needed and open its private local page |
| `relmio stop` | Gracefully stop only the Relmio dashboard process |

The protected on-disk publication and authenticated health response must name
the exact installed Relmio version. A dashboard from another Relmio version is never
reported as current or opened by a newer command. Before or after upgrading,
use the matching lifecycle form to check and replace it explicitly:

```bash
relmio status
relmio stop
relmio start
relmio open
```

`relmio stop` remains available only when the prior process has the compatible
control protocol, exact recorded process identity, and authenticated control
key. Relmio does not delete malformed or incompatible control state to force an
upgrade.

These commands do not start, stop, restart, rebuild, recreate, or remove n8n,
ngrok, model endpoints, bridges, Assistant companions, or unrelated
containers. `relmio stop` stops only the Relmio dashboard process, verifies
the recorded process identity, and uses its
separately authenticated loopback control endpoint. It has no PID-only kill
fallback.

Running bare `relmio` opens the foreground first-run wizard. Running `relmio
local` opts into the persistent dashboard, while `relmio vps` and `relmio
assistant` open their respective wizard route on that private dashboard
process. If automatic browser opening fails for a persistent process, fix the
operating system's default-browser launcher and run `relmio open` again;
Relmio does not print its private session value.

A same-tab reload keeps the temporary wizard capability only in the current
tab's clean GET history entry while that Relmio process remains open. The value
stays out of browser process arguments and the visible address bar. The private
file handoff is single-use and expires after 30 seconds; its independent
per-tab transfer is cleared before application startup and expires after 10
seconds. A new tab, copied clean `/local` address, or bookmark cannot reconnect;
use `relmio open` to create a fresh handoff to the active process.

When you use the VPS route, select **Disconnect from VPS** as soon as you are
finished. The server also closes an authenticated SSH session after 15 minutes
of inactivity. An active VPS operation holds a bounded lease, so discovery or
an approved install is not interrupted by that idle timer.

## Upgrading an older API installation

The dashboard does not show or manage legacy API-key endpoints. Upgrading
leaves their containers and credential volumes untouched, so they can remain
running. Use the [legacy retirement guide](local-endpoints.md#retired-api-installations)
to review and stop only an exactly owned endpoint. Dashboard absence is not
proof that an old endpoint has stopped.

## Read the inventory

**Refresh status** first forgets abandoned setup drafts, staged replacements,
and tester sessions from the dashboard tab. It preserves an active
system-browser SIWC sign-in attempt. It then performs read-only discovery of
the local Docker context and versions, Relmio's fixed managed paths, ownership
markers, exact Docker objects, network and publication boundaries, Compose
state, and generated health checks. This does not change an installed service:
it does not install, start, restart, recreate, remove, or execute inside a
container.

Relmio's dashboard always has these eight rows, even when nothing is installed.

| Dashboard service | Verified connection details | Actions after current attestation |
|---|---|---|
| **Codex App Server (ChatGPT plan)** | Loopback WebSocket URL | **Set up** when absent; **Sign in**, **Manage account**, or local capability rotation when offered |
| **Codex Chat Adapter** | Loopback HTTP `/chat` URL | **Set up** when absent; **Manage account** or local capability rotation when offered |
| **SuperGrok** | Loopback SuperGrok Chat Completions URL | **Set up** when absent; sign-in/sign-out guidance and local capability rotation when offered |
| **n8n + ngrok** | Local n8n, authenticated ngrok, and loopback inspector URLs | **Set up** when absent; **Resume** or **Review removal** only after exact ownership attestation |
| **AI Assistant tools** | Private Code Sandbox and optional SearXNG | **Set up**, manage optional search, or **Review removal** after ownership attestation |
| **ChatGPT plan sidecar** | Private `http://n8n-openai-oauth:10531/v1` | **Set up**, **Manage account**, or **Review removal** after current ownership attestation |
| **SuperGrok for n8n** | Private `http://n8n-supergrok:14502/v1` | **Set up**, official sign-in/sign-out guidance, or **Review removal** only when offered |
| **Local model for n8n** | Private `http://n8n-local-model:11434/v1`; model readiness and selected ID | **Set up**, **Review model retry**, or **Review removal** only when offered |

The local-model row distinguishes an installed runtime from a downloaded,
inference-verified model. **Review model retry** repeats the reviewed selection
and retains its cache. **Review removal** requires a separate confirmation
that deletes the model cache as well as the owned runtime and files. No model
bearer or provider sign-in is involved; the API-key value n8n requires is ignored.


Copy buttons accept only verified URLs for the selected service. The OAuth
bridge works only inside its selected Docker network. Grok Build's healthy
container state does not prove that OAuth or live inference is ready.

## Use the state and action matrix

An action appears only when the latest inventory returned the exact capability
for that service.

| State | What Relmio proved | What you can do |
|---|---|---|
| **Checking** | A new inventory is running | Wait; all actions are disabled |
| **Healthy** | Ownership, boundary, expected resources, and generated health checks passed | Use only the actions shown for that service |
| **Stopped** | The exact owned service exists but is not running | Resume the owned n8n stack when offered, or review an offered removal |
| **Needs recovery** | Managed evidence is incomplete or runtime state is mixed | Use only an explicitly attested recovery action; otherwise inspect without changing anything |
| **Unavailable** | Relmio could not prove a safe state | No setup or maintenance action is available for that row |
| **Stale** | The last verified snapshot is more than five minutes old | Refresh status before using any action |
| **Not configured** | No Relmio-managed installation exists at the fixed path | Select **Set up** to open that service's reviewed setup flow |
| **Legacy ChatGPT target** | An old credential-copy sidecar was detected; it is not a verified SIWC installation and may still be running until migration is approved | **Set up** opens a separate fresh-SIWC migration review. Only after final confirmation does Relmio stop the exact attested old service; old credential/workspace volumes remain offline and preserved. Incomplete migrations require inspection; no automatic resume or deletion occurs. |

Installed Codex and n8n sidecars use the selected SIWC registration. **Manage
account** reports identity, plan permission, enabled/paused state, and
ownership without exposing provider tokens. Sign-in, permission to use the
ChatGPT plan, and an actual successful model request remain separate checks.

For a local n8n sidecar, sign-out and plan-disable stop the exact attested
sidecar before changing its registration. If Relmio cannot confirm the stop,
the account mutation is not attempted. For a VPS sidecar, it rechecks the
selected SSH identity and Compose ownership and confirms the sidecar stopped
before the operation. Neither action changes n8n.

The first-use plan notice must be acknowledged before plan models are
available. **Manage usage** opens ChatGPT's usage settings. A plan usage-limit
error does not switch accounts or billing; follow its recovery action.

## Keep credentials separate

The dashboard returns sanitized account state and allowlisted URLs. It never
returns a provider access or refresh token, local client bearer, ngrok token,
Basic Auth password, n8n encryption key, or Assistant runner secret.

- The one-time bearer for a local endpoint or n8n sidecar appears only on its
  installation result. Relmio stores its verifier, not the raw bearer.
- SIWC tokens stay in the protected registration owned by the local runtime or
  installed destination. Sign-out clears local tokens and reports whether
  provider revocation was confirmed.
- The Assistant sandbox key and settings appear once after setup. Dashboard
  refresh reports only whether the component is configured.
- Returning to the dashboard clears pending plans, confirmations, sign-in
  links, and one-time result values. Copy any value you need before returning.

## Distinguish the provider session from local bearers

The selected SIWC registration authorizes provider access. Local Relmio
bearers authorize a particular client surface:

- The App Server bearer grants a trusted native client a high-trust local
  JSON-RPC connection.
- The Chat Adapter bearer is limited to its read-only conversational HTTP
  route.
- The n8n sidecar bearer authorizes only the selected private Docker-network
  gateway; n8n does not receive the OpenAI token.

The App Server child receives `ACCESS_TOKEN` in its environment. A trusted
same-UID tool may inspect its own process environment or files. Treat the raw
App Server client as high trust; Relmio does not claim to isolate its own
authorized client from its process context. The Chat Adapter remains separate
and read-only.

## Keep provider accounts explicit

Each saved ChatGPT registration is bound to verified issuer, issued client ID,
and subject. Email is a display label, not a merge key. Choose the registration
you intend to use; Relmio does not maintain an account pool or change accounts
after an error.

Sign-out clears local tokens and attempts provider revocation. If revocation is
unconfirmed, use ChatGPT's disconnection controls. Deleting local registration
data is not proof of provider-side revocation or deletion.

The experimental SuperGrok adapter uses the pinned official Grok CLI for fresh
OAuth/device sign-in and sign-out in its own private volume. The direct HTTP
handler reads only that runtime's marked session to call xAI's documented CLI
chat proxy. It does not inspect another app's credentials, import tokens,
replay browser cookies, or accept an xAI API key. The CLI remains the sole
credential writer; the HTTP handler never consumes refresh tokens.

Local Grok apps use `/v1/chat/completions` with a separate Relmio client
bearer. `grok-build` remains a legacy routing alias. n8n executes its own tools
and returns matching results. Browser bundles must not hold the local bearer.
Relmio does not rotate accounts or switch billing after provider errors.

## Preserve n8n operator ownership

For the OAuth bridge and Assistant tools, the selected n8n container and
Docker network remain operator-owned. Dashboard inventory rechecks their exact
identity, network membership, and health before reporting the companion as
healthy. It does not edit n8n configuration, execute inside n8n, or stop,
restart, rebuild, recreate, or change the network membership of n8n.

Bridge runtime updates, credential refreshes, and companion removal target only
the separately owned Relmio project after another review and confirmation. The
**n8n + ngrok** row is a different option: that whole disposable stack is
Relmio-owned and has its own resume and removal checks.

On native Windows, inventory verifies the existing owner-only ACLs without
repairing them. Before a managed action changes Docker state, Relmio checks the
ACLs again and stops before the mutation if they have drifted.

## Add another connection

Select **Add connection** to open the same four-step setup flow:

1. **Choose** a connection.
2. **Review** its network and credential boundary.
3. **Install** only after entering the required credential and confirming the
   current plan.
4. **Ready** shows verified connection details and any one-time value.

Use **Back to dashboard** when you are done. The dashboard then runs a fresh
inventory. It does not reuse the previous setup plan.


## Provider controls

The dashboard distinguishes runtime health, provider readiness, and inventory
freshness. A healthy container does not prove identity verification, a granted
ChatGPT plan permission, model entitlement, or a completed request.

Open **Add connection** and choose the ChatGPT route to select or manage saved
SIWC registrations. The account view distinguishes identity-only, plan-paused,
plan-active, signed-out, reauthorization-required, and transferred states. It
never returns provider tokens. Plan use requires the separate ChatGPT grant and
first-use confirmation; **Manage usage** opens ChatGPT settings.

SuperGrok remains a separate official CLI-managed session. Its sign-in,
catalog, and inference status do not establish ChatGPT account state or
permission.
