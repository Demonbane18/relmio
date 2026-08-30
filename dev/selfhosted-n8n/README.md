# Disposable self-hosted n8n + ngrok harness

This maintainer-only harness runs a new, disposable n8n instance and publishes only its editor/webhook HTTP port through an authenticated ngrok reverse tunnel. It never touches an existing n8n stack.

## Prerequisites

- Node.js 22 or newer.
- A Linux-container Docker engine, using [Docker Desktop](https://docs.docker.com/desktop/) on macOS or Docker Desktop/Docker Engine on Linux. Windows hosts, including Docker Desktop with its named-pipe context, are deliberately unsupported by this Unix-socket harness.
- Docker Compose v2.17.0 or newer. Confirm the separately installed Linux plugin with `docker compose version`.
- An ngrok [reserved development domain](https://ngrok.com/docs/gateway/domains) such as `your-name.ngrok.app`.
- A dedicated, ACL-scoped ngrok authtoken created only for this disposable test. Give it a `bind:<NGROK_DOMAIN>` ACL and never reuse a production token. See ngrok's current [agent authtoken guidance](https://ngrok.com/docs/agent#authtokens).

The Compose setup follows the current official [n8n Docker guidance](https://docs.n8n.io/hosting/installation/docker/) and [ngrok Docker guidance](https://ngrok.com/docs/using-ngrok-with/docker/). Public requests are gated by ngrok's supported [Traffic Policy Basic Auth action](https://ngrok.com/docs/gateway/traffic-policy/actions/basic-auth).

## Configure and run

From this directory:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -base64 32
```

Put the first generated value in `N8N_ENCRYPTION_KEY`, the second in `NGROK_BASIC_AUTH_PASSWORD`, and replace every other placeholder. Use the reserved hostname without `https://` for `NGROK_DOMAIN`. The harness rejects a group/world-readable `.env` on POSIX; keep it at mode `0600`. `config` is non-exposing; set `RELMIO_TEST_PUBLIC_CONFIRMATION=EXPOSE_DISPOSABLE_N8N` only immediately before `up`.

```sh
node harness.mjs config
node harness.mjs up
node harness.mjs status
```

A SHA-256-derived per-checkout project name keeps two checkout paths from sharing containers, networks, or volumes. The selected Docker context must resolve to a local Unix socket; Docker selection environment overrides are rejected. The attested socket is recorded in the mode-`0600` ownership marker, and every Compose lifecycle command is pinned to it even if the selected context later changes.

`up` writes `.runtime/traffic-policy.yml` inside a mode-`0700` directory. The mounted policy itself is mode `0644` so the ngrok image's non-root user can read it through Docker's bind mount; host users still cannot traverse the private parent directory. Both single-container file mounts use Docker's private `Z` relabel option for SELinux-enforcing Linux hosts. The harness validates Compose, writes the ownership marker, then gives Compose up to 90 seconds to report n8n healthy and ngrok merely running. It does not check the ngrok inspector or prove that the public tunnel is reachable. The Compose `up` subprocess has a 10-minute ceiling, including first-time image downloads; complete the Opera GX and webhook checks below. Every lifecycle command also holds `.runtime/lifecycle.lock`; if a crash leaves it behind, confirm no harness command is running before removing only that lock. n8n is bound locally at `127.0.0.1:${N8N_LOCAL_PORT}`; ngrok's inspector is bound at `127.0.0.1:${NGROK_INSPECTOR_PORT}`. Both port settings reject Relmio's reserved port `10531`.

`config` uses the generated policy only for Compose validation and removes it afterward when this checkout has no ownership marker, so a dry validation does not leave the Basic Auth password on disk.

## Acceptance in Opera GX

1. Open `https://<NGROK_DOMAIN>` in Opera GX and enter the public Basic Auth username and password from `.env`.
2. Complete n8n's disposable owner setup and confirm the editor loads over HTTPS.
3. Create a temporary Webhook workflow, listen for its test event, and call the displayed HTTPS test URL from an HTTP client that can send the same Basic Auth credential. Confirm the execution arrives in n8n, then delete the workflow.
4. Do not weaken or remove Basic Auth for webhook providers that cannot send it. Use a test client that supports Basic Auth instead.

`N8N_WEBHOOK_URL` and `N8N_EDITOR_BASE_URL` are set to the reserved HTTPS domain, with one trusted proxy hop as described by n8n's current [reverse-proxy webhook guidance](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/configure-webhook-urls-with-reverse-proxy/).

## Exact cleanup

Run:

```sh
node harness.mjs down
```

The command verifies `.runtime/owner.json` matches this canonical checkout and its derived project before invoking that project's `down --volumes --remove-orphans`. A missing, malformed, permissive, or mismatched marker fails closed before Docker runs. Successful cleanup removes the disposable containers, project network, named n8n data volume, password-bearing policy, and marker. It never runs a global Docker prune.

If `up` fails or is interrupted, it deliberately preserves the marker, policy, containers, and volume for diagnosis and reports this same exact cleanup command. After inspection, run `node harness.mjs down`; do not substitute a manually guessed project name.

## Proof boundary

This harness tests a standalone n8n editor and webhook round-trip through ngrok. It **does not prove the Relmio SSH installer path**, remote discovery, installation, or cleanup. Port `10531` and all Relmio endpoints are never exposed. No live Docker, ngrok, n8n, or Opera GX verification is claimed by these files alone.
