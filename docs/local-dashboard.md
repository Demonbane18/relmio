# Use the local dashboard

After you start Relmio, the local dashboard rediscovers the services Relmio
manages on this computer. You can copy verified connection URLs, open a
reviewed maintenance action, or start the existing setup wizard.

An installed Relmio command can keep this dashboard running in the background.
It does not install an operating-system login service or start at login.

## Start the dashboard

Install the published command with Node.js 22 or newer:

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

That command starts the same persistent owner-scoped dashboard and opens it.
Because it does not place `relmio` on your PATH, repeat the full NPX command
for later lifecycle actions:

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

Use the [hosted install page](https://relmio.vercel.app/install) when you need
the native macOS, Linux, PowerShell, or Command Prompt launcher. A hosted
launcher can use a verified temporary Node.js runtime, so it deliberately runs
Relmio as a foreground, one-shot process and removes that runtime afterward.
It does not install a persistent command. Do not run `relmio assistant` for
this page. That command opens the separate Assistant-only wizard.

Run `relmio vps` to open the separate VPS setup directly. You can also reach
it from **Set up the VPS version** in the local flow.

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

Running `relmio` or `relmio local` starts the dashboard when needed and opens
it. `relmio vps` and `relmio assistant` open their respective wizard route on
the same private dashboard process. If automatic browser opening fails, fix
the operating system's default-browser launcher and run `relmio open` again;
Relmio does not print the private session value from a persistent process.

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

## Read the inventory

**Refresh status** first forgets abandoned setup drafts, staged replacements,
and tester sessions from the dashboard tab. It preserves an active ChatGPT or
Codex sign-in helper. It then performs read-only discovery of the local Docker
context and versions, Relmio's fixed managed paths, ownership markers, exact
Docker objects, network and publication boundaries, Compose state, and
generated health checks. This does not change an installed service: it does
not install, start, restart, recreate, remove, or execute inside a container.

The inventory always has these six rows, even when nothing is installed:

| Dashboard service | Verified connection details | Actions after current attestation |
|---|---|---|
| **OpenAI API** | Loopback HTTP URL ending in `/v1` | **Set up** when absent; **Rotate credential** when healthy |
| **Codex (ChatGPT login)** | Loopback App Server WebSocket URL | **Set up** when absent; **Sign in** and **Rotate credential** when healthy |
| **Codex Chat adapter** | Loopback HTTP adapter URL | **Set up** when absent; **Sign in** and **Rotate credential** when healthy |
| **n8n + ngrok** | Local n8n URL, authenticated public ngrok URL, and loopback ngrok inspector URL | **Set up** when absent; **Resume** when the exact owned stack is stopped; **Review removal** only when an owned recovery action is attested |
| **OpenAI OAuth bridge** | `http://n8n-openai-oauth:10531/v1` inside the selected Docker network | **Set up** when absent; **Refresh credential** when healthy; **Review removal** only for an exactly attested owned service |
| **AI Assistant tools** | Installed component state; no stored sandbox key | **Set up** when absent; **Review removal** only for an exactly attested owned project |

The dashboard copy buttons accept only the verified URL forms for each row.
The three endpoint URLs must use their expected loopback protocol, path, and
port. The owned n8n stack may also show its configured HTTPS ngrok hostname.
The OAuth bridge address is fixed and works only inside its selected Docker
network.

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
| **Not configured** | No Relmio-managed installation exists at the fixed path | Select **Set up** to open the four-step wizard |

Refreshing inventory and refreshing a bridge credential are different actions.
**Refresh status** only reads. **Refresh credential** opens the bridge's
existing sign-in, ownership, review, and confirmation flow before it changes
the owned sidecar credential.

## Keep credentials separate

The dashboard returns sanitized state and allowlisted URLs. It never returns a
stored Platform API key, ChatGPT session, OAuth token, local client credential,
ngrok token, Basic Auth password, n8n encryption key, or Assistant runner
secret.

- A local endpoint capability or Chat Adapter bearer appears once after setup
  or rotation. Relmio stores its verifier, not the raw replacement. Save the
  displayed value before leaving the result screen.
- The OAuth bridge credential stays server-managed. The dashboard can open its
  separately confirmed refresh flow, but it cannot reveal the saved token.
- The Assistant sandbox key and settings appear once after setup. Dashboard
  refresh reports only whether the component is configured.
- Returning to the dashboard clears pending plans, confirmations, sign-in
  links, and one-time result values. Copy any value you need before returning.

## Distinguish Codex sign-in from the local bearer

The two Codex credentials have different jobs:

- ChatGPT device sign-in authorizes Codex inside its isolated container.
- The App Server capability or Chat Adapter bearer authorizes your client to
  connect to the local Relmio endpoint.

Selecting **Sign in** on a healthy Codex row opens installed-endpoint
management. It does not claim that the saved ChatGPT sign-in or local client
credential is valid, and it does not start a browser sign-in by itself. Start
a fresh device-code sign-in there only when you need one.

Rotating the local credential does not refresh ChatGPT sign-in. Repeating
ChatGPT sign-in does not replace the App Server capability or Chat Adapter
bearer.

## Keep provider accounts explicit

Relmio's Codex targets use the official Codex App Server. Codex owns the ChatGPT OAuth flow,
stores the active credential, and refreshes it. Each Codex
target has one active ChatGPT account. Changing accounts requires an explicit
sign-out and a new sign-in; Relmio does not pool accounts.

No xAI target is enabled in this release. xAI/Grok authentication is API-key only. Relmio does not implement third-party Grok OAuth.
Future provider authentication is denied by default until official
documentation defines a supported method and Relmio adds a reviewed
implementation.

Relmio never changes accounts or keys automatically after a 401, 403, or 429,
rate-limit, or quota response. It reports the failure and waits for the account
owner to act. The dashboard may report that a credential is configured, but it
never returns or re-shows a stored secret.

## Preserve n8n operator ownership

For the OAuth bridge and Assistant tools, the selected n8n container and
Docker network remain operator-owned. Dashboard inventory rechecks their exact
identity, network membership, and health before reporting the companion as
healthy. It does not edit n8n configuration, execute inside n8n, or stop,
restart, rebuild, recreate, or change the network membership of n8n.

Bridge refresh and companion removal target only the separately owned Relmio
project after another review and confirmation. The **n8n + ngrok** row is a
different option: that whole disposable stack is Relmio-owned and has its own
resume and removal checks.

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
