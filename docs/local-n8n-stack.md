# New local n8n with optional ngrok

Relmio creates a new disposable n8n installation, private to this computer by
default. The stack uses n8n 2.42.5. You can opt into a public ngrok URL
protected by Basic Auth. Use this option when you do not already run local
n8n. Add-ons are reviewed separately after setup.

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
- on Windows, enough free RAM for Docker Desktop's WSL engine. If Docker Desktop
  was idle, creating the stack starts that VM; close other apps first. Windows
  error `0x800705aa` means the VM could not start;
- one unused loopback port for n8n;
- only if you enable ngrok: an account, a static hostname from the [ngrok
  Domains dashboard](https://dashboard.ngrok.com/domains), an agent token from
  [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken), a
  unique Basic Auth username and password, and another unused loopback port
  for the inspector.

**Your Authtoken** and **Settings → Authtokens** name the same ngrok
agent-credential type. This applies only when ngrok is enabled. Paste one
active token value, not its label or the `ngrok config add-authtoken` command.
The Basic Auth pair does not come from ngrok or n8n: create a username and a
unique password of at least 12 characters for people who may open this public
URL.

ngrok is off by default. If enabled, its URL is public and anyone can reach the
Basic Auth prompt. Use a unique password and protect the URL and credentials.
Basic Auth does not permit other people to use your ChatGPT plan through
workflows. Relmio uses ngrok's Traffic Policy Basic Auth, not the deprecated
command-line flag. See ngrok's [Docker guide](https://ngrok.com/docs/using-ngrok-with/docker)
and [agent documentation](https://ngrok.com/docs/agent).

Code Sandbox stacks need Docker Desktop's privileged containers (Linux engine)
on macOS and Windows.

## Install with the browser wizard

1. Start the latest Relmio wizard:

   ```bash
   npx --yes --ignore-scripts relmio@latest
   ```

2. Use the dashboard that Relmio opens through its owner-only browser handoff.
   If it does not open, press Enter in the active foreground terminal or run
   `relmio open` from a persistent install.
3. Choose **Add connection**, then **Set up new n8n**.
4. Choose the local n8n port and timezone. Leave **Public URL with ngrok
   (optional)** off for private access. If enabled, enter the reserved hostname
   and inspector port; supply the ngrok token and Basic Auth pair at
   installation.
5. Choose an Assistant mode. **Disabled** adds no Assistant services.
   **Code Sandbox** adds private sandbox services. **Code Sandbox + SearXNG**
   also adds private web search.
6. Review the access mode, owned resources, any privileged runner, and removal
   scope. Confirm the plan, including public exposure if selected, then install.
7. On Ready, choose **Open n8n** and create its owner account. If you enabled
   ngrok, also check its URL in a private browser window. Basic Auth must block
   access until you enter your chosen credentials.
8. Ready offers **Add ChatGPT plan**, **Add local model**, **Add SuperGrok**,
   and **Add Assistant tools**. The Assistant tools button is hidden if this
   stack includes Code Sandbox. Each add-on flow preselects this n8n and its
   network, then requires its own review. From **Add connection**, the managed
   n8n and network are preselected too; the network is labelled `<name>,
   recommended for this n8n`.

The wizard clears ngrok and Basic Auth credentials from the browser after the
request. It returns URLs and service names, never the stored secrets.

## Network boundary

Private mode exposes only local n8n. Enabling ngrok adds a public route and a
loopback inspector.

| Surface | Reachability |
|---|---|
| Local n8n | `http://127.0.0.1:<selected-port>` |
| Optional public n8n route | `https://<reserved-hostname>` through ngrok and mandatory Basic Auth |
| Optional ngrok inspector | `http://127.0.0.1:<selected-inspector-port>` |

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
first startup while ngrok is enabled, Relmio rechecks ownership and removes
the failed owned resources once. Only when that recheck proves no owned
resources remain does the wizard keep the reviewed non-secret plan open, clear
the ngrok and Basic Auth fields, and ask you to check the hostname and active
agent authtoken before retrying. Any uncertain cleanup or remaining owned
resource instead stays in partial recovery.

## Data and removal

n8n workflows and credentials live in the owned `n8n-data` volume at
`/home/node/.n8n`. The stack's protected `.env` holds its encryption key.
Protect backups of both. Long-running services use `restart: unless-stopped`,
including ngrok if enabled; closing Relmio does not stop them. The certificate
initializer is a one-shot service.

Removal is refused while add-on containers remain attached. Remove those
add-ons first, then separately confirm **Remove local n8n stack**. That action
deletes the owned stack resources and data. Export anything you need first.
Existing public stacks are not made private by this update.

## Add ChatGPT plan, a local model and more

Ready offers ChatGPT plan, local model, SuperGrok and Assistant tools with this
n8n and its network preselected. ChatGPT still requires separate plan
permission and background-workflow approval.

After an approved ChatGPT, local-model or SuperGrok install, Relmio tries to
import the connection into this owned n8n. ChatGPT uses **Relmio ChatGPT plan**
with a local bearer and `http://n8n-openai-oauth:10531/v1`. OpenAI tokens stay
in the sidecar. The local model uses an ignored placeholder. Assistant tools do
not receive a model credential through this import.

Only credential IDs, names and timestamps are recorded in
`.runtime/credentials.json`. If setup cannot be confirmed, check for the named
credential in n8n before entering the one-time key manually. Use the ChatGPT
credential only for your own approved workflows in this n8n. See
[n8n configuration](n8n-configuration.md). Platform API access remains
separate.
