# New local n8n with ngrok

Relmio can create a new disposable n8n installation and publish only its editor
and webhook route through ngrok Basic Auth. Use it when you do not already run
local n8n. It is separate from the existing-n8n bridge and Assistant options.

Relmio never adopts or changes another n8n installation. The new stack gets a
random Compose project identity, exact ownership labels, its own n8n data
volume, and its own managed directory:

```text
~/.relmio/local/n8n-stack
```

## Before you begin

You need:

- native Windows with Docker Desktop's `desktop-linux` engine, macOS, Linux,
  or Linux under WSL2;
- Docker Engine or Docker Desktop with Docker Compose v2;
- on Windows, enough free RAM for Docker Desktop's WSL engine. If Docker Desktop was idle, creating the stack starts that VM; close other apps first. Windows error `0x800705aa` means the VM could not start;
- an ngrok account, a static hostname created or selected in the
  [ngrok Domains dashboard](https://dashboard.ngrok.com/domains), and the
  matching value from [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken);
- a strong Basic Auth username and password for the public route; and
- two unused loopback ports for local n8n and the ngrok inspector.

**Your Authtoken** and **Settings → Authtokens** in ngrok refer to the same
agent-credential type; paste only one active token value, not its label or the
`ngrok config add-authtoken` command. The Basic Auth pair does not come from
ngrok or n8n: create a username and a unique password of at least 12 characters
for people who may open this public URL.

The ngrok endpoint is public. Anyone can reach its sign-in prompt, so use a
unique password and keep the URL and credentials private. Relmio uses ngrok's
Traffic Policy Basic Auth, not the deprecated command-line flag. See ngrok's
[Docker guide](https://ngrok.com/docs/using-ngrok-with/docker) and
[agent documentation](https://ngrok.com/docs/agent).

## Install with the browser wizard

1. Start the latest Relmio wizard:

   ```bash
   npx --yes --ignore-scripts relmio@latest
   ```

2. Use the dashboard that Relmio opens through its owner-only browser handoff.
   If it does not open, press Enter in the active foreground terminal or run
   `relmio open` from a persistent install.
3. Choose **Local endpoints**, then **New local n8n + ngrok**.
4. Enter the reserved ngrok hostname, authtoken, Basic Auth username and
   password, local n8n port, ngrok inspector port, and timezone.
5. Choose an Assistant mode:
   - **Off** creates only n8n and ngrok.
   - **Code Sandbox** adds the private n8n Sandbox services.
   - **Code Sandbox + SearXNG** also adds private JSON web search.
6. Review the public URL, two loopback publications, owned project boundary,
   privileged-runner warning, and removal scope.
7. Confirm the public exposure explicitly, then install.
8. Open the returned public URL in an anonymous/private browser window. The
   Basic Auth challenge must block access. Enter the username and password you
   chose and confirm that n8n then loads before relying on the public route.

The wizard clears ngrok and Basic Auth credentials from the browser after the
request. It returns URLs and service names, never the stored secrets.

## Network boundary

The generated stack exposes exactly three deliberate surfaces:

| Surface | Reachability |
|---|---|
| n8n editor and webhooks | `https://<reserved-hostname>` through ngrok and mandatory Basic Auth |
| Local n8n | `http://127.0.0.1:<selected-port>` |
| ngrok inspector | `http://127.0.0.1:<selected-inspector-port>` |

Port `10531` is never published. Optional Code Sandbox and SearXNG services
publish no host ports and are not attached to the ngrok edge network. The
privileged Docker-in-Docker runner is for local development and testing; use
n8n's recommended Daytona path for production isolation.

Relmio pins every generated production image to an immutable digest, verifies
the exact owned containers, networks, and volumes, and rejects real or
malformed host publications. Docker Compose's unpublished placeholder
(`PublishedPort: 0` with an empty URL) is accepted only for the private
Assistant services.

Install and removal operations use a private lifecycle lock tied to the
process creation identity, not only its reusable PID. Interrupted operations
can recover after a bounded publication grace, while active or ambiguous
owners fail closed. A nested reclaim claim prevents an older paused process
from moving a newer active lock.

## Reopening a managed stack

On reopening the wizard, Relmio reads the managed-root marker, stack marker,
current local Docker context, exact ownership labels, and expected resource
names before it offers any stack action. It reports one of these safe states:

| State | Wizard behavior |
|---|---|
| **Healthy** | Normal local endpoint management and add-on choices remain available. Relmio does not restart the stack. |
| **Stopped, complete** | The wizard offers **Resume owned stack**. It uses `docker compose start` only for the already-attested long-running containers; it does not create, recreate, rebuild, remove, or reconfigure services or volumes. |
| **Partial** | The wizard offers only the separately confirmed removal recovery. This includes a missing subset or an unhealthy/mixed runtime state. |
| **Unavailable** | Relmio could not safely classify the prior state. It offers neither automatic resume nor removal and never guesses from Docker text. |

Before declaring an Assistant-enabled stack ready, Relmio also verifies that
the exact owned `assistant-shared` and `assistant-internal` Docker networks
report `Internal: false`. This keeps their intended network egress behavior
explicit after removing Compose's incompatible `internal: true` flags; it does
not publish any Assistant host ports.

If ngrok rejects an otherwise well-formed token or reserved hostname during
first startup, Relmio rechecks ownership and removes the failed owned resources
once. Only when that recheck proves no owned resources remain does the wizard
keep the reviewed non-secret plan open, clear every credential field, and ask
you to check the hostname and active agent authtoken before retrying. Any
uncertain cleanup or remaining owned resource instead stays in partial recovery.

## Data and removal

n8n workflows and credentials live in the owned `n8n-data` Docker volume. A
normal Docker restart preserves that volume, but this option is intentionally
disposable: the separately confirmed **Remove local n8n stack** action removes
the owned containers, networks, volumes, and managed files. Export anything you
want to keep before removal.

Removal first re-attests the marker, Docker socket, random project identity,
exact resource names, and every Relmio ownership label. If any ownership detail
is missing, extra, or malformed, Relmio fails closed and leaves the evidence in
place for inspection. It does not inspect, stop, rebuild, recreate, or remove
unrelated n8n or Docker resources.

## Add ChatGPT/Codex model access later

The new stack does not turn a ChatGPT subscription into an API credential. To
add the unofficial private n8n OAuth bridge later, start a fresh Relmio wizard,
choose **Self-hosted n8n bridge**, and select this new running n8n container and
its private shared network. OpenAI Platform models remain a separately billed
credential configured directly in n8n.
