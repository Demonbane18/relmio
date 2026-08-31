# New local n8n with ngrok

Relmio can create a new, disposable self-hosted n8n installation and publish
only its editor and webhook route through an authenticated ngrok endpoint. This
is an add-on for people who do not already have a local n8n deployment. It is
separate from the existing-n8n bridge and Assistant companion options.

Relmio never adopts or changes another n8n installation. The new stack gets a
random Compose project identity, exact ownership labels, its own n8n data
volume, and its own managed directory:

```text
~/.relmio/local/n8n-stack
```

## Before you begin

You need:

- macOS, Linux, or Linux under WSL2;
- Docker Engine or Docker Desktop with Docker Compose v2;
- an ngrok account, a static hostname created or selected in the
  [ngrok Domains dashboard](https://dashboard.ngrok.com/domains), and the
  matching value from [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken);
- a strong Basic Auth username and password for the public route; and
- two unused loopback ports for local n8n and the ngrok inspector.

The ngrok endpoint is public internet infrastructure. Anyone can reach its
authentication challenge, so use a unique password and do not share the URL or
credentials. Relmio uses ngrok's recommended Traffic Policy Basic Auth rather
than the deprecated command-line Basic Auth flag. See ngrok's official
[Docker guide](https://ngrok.com/docs/using-ngrok-with/docker) and
[agent documentation](https://ngrok.com/docs/agent).

## Install with the browser wizard

1. Start the latest Relmio wizard:

   ```bash
   npx --yes --ignore-scripts relmio@latest
   ```

2. Open the complete one-time URL printed in the terminal in your browser.
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

The wizard clears the submitted ngrok and Basic Auth credentials from its
browser state after the request. It returns URLs and service names, never the
secrets written into the owner-only managed files.

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
