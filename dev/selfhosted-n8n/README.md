# Disposable self-hosted n8n + ngrok harness

This maintainer-only harness runs a new, disposable n8n instance and publishes only its editor/webhook HTTP port through an authenticated ngrok reverse tunnel. It can also start n8n's private AI Assistant Code Sandbox and optional SearXNG web search. It never touches an existing n8n stack.

## Prerequisites

- Node.js 22 or newer.
- A Linux-container Docker engine, using [Docker Desktop](https://docs.docker.com/desktop/) on macOS or Docker Desktop/Docker Engine on Linux. Windows hosts, including Docker Desktop with its named-pipe context, are deliberately unsupported by this Unix-socket harness.
- Docker Compose v2.17.0 or newer. Confirm the separately installed Linux plugin with `docker compose version`.
- An ngrok [reserved development domain](https://ngrok.com/docs/gateway/domains) such as `your-name.ngrok.app`.
- A dedicated, ACL-scoped ngrok authtoken created only for this disposable test. Give it a `bind:<NGROK_DOMAIN>` ACL and never reuse a production token. See ngrok's current [agent authtoken guidance](https://ngrok.com/docs/agent#authtokens).
- For either Assistant mode, at least 4 GB RAM and 2 vCPUs. The privileged sandbox runner is a local-development dependency, not a production deployment pattern.

The Compose setup follows the current official [n8n Docker guidance](https://docs.n8n.io/hosting/installation/docker/), [AI Assistant setup](https://docs.n8n.io/hosting/configuration/configuration-examples/ai-assistant/), [Sandbox Service](https://github.com/n8n-io/n8n-sandbox-service), and [ngrok Docker guidance](https://ngrok.com/docs/using-ngrok-with/docker/). Public requests are gated by ngrok's supported [Traffic Policy Basic Auth action](https://ngrok.com/docs/gateway/traffic-policy/actions/basic-auth).

## Configure and run

From this directory:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -base64 32
```

Put the first generated value in `N8N_ENCRYPTION_KEY`, the second in `NGROK_BASIC_AUTH_PASSWORD`, and replace every other placeholder. Use the reserved hostname without `https://` for `NGROK_DOMAIN`. The harness rejects a group/world-readable `.env` on POSIX; keep it at mode `0600`. `config` is non-exposing; set `RELMIO_TEST_PUBLIC_CONFIRMATION=EXPOSE_DISPOSABLE_N8N` only immediately before `up`.

Choose one exact Assistant mode in `.env`:

- `disabled` (default): n8n and ngrok only.
- `sandbox`: adds the n8n AI Assistant Sandbox Service.
- `sandbox-with-searxng`: adds the Sandbox Service and private SearXNG JSON web search.

The two enabled modes start a privileged Docker-in-Docker runner. A privileged container is host-root-equivalent inside the Docker Desktop VM or Linux host, so enable it only for this disposable local test. Set `RELMIO_TEST_PRIVILEGED_SANDBOX_CONFIRMATION=RUN_PRIVILEGED_CODE_SANDBOX` to acknowledge that boundary. The harness generates four independent 256-bit secrets into `.runtime/assistant-secrets.env` at mode `0600`; do not copy them into `.env`, logs, or commits.

This is the Instance AI Assistant's build sandbox. It is not the external Code node task runner used to isolate normal workflow JavaScript or Python execution. This privileged local development stack is not production; for production, follow n8n's Daytona guidance or use a reviewed Linux/Sysbox deployment.

```sh
node harness.mjs config
node harness.mjs up
node harness.mjs status
```

A SHA-256-derived per-checkout project name keeps two checkout paths from sharing containers, networks, or volumes. The selected Docker context must resolve to a local Unix socket; Docker selection environment overrides are rejected. The attested socket and Assistant mode are recorded in the mode-`0600` per-checkout ownership marker, and every Compose lifecycle command is pinned to them even if the selected context or `.env` later changes.

`up` writes `.runtime/traffic-policy.yml` inside a mode-`0700` directory. The mounted policy and optional SearXNG settings are mode `0644` so their non-root containers can read them through Docker bind mounts; host users still cannot traverse the private parent directory. Both single-container file mounts use Docker's private `Z` relabel option for SELinux-enforcing Linux hosts. The harness validates Compose, writes the ownership marker, then gives Compose up to 90 seconds to report n8n healthy and the Sandbox API healthy while ngrok, the runner, and optional SearXNG are running. It does not check the ngrok inspector or prove that the public tunnel is reachable. The Compose `up` subprocess has a 10-minute ceiling, including first-time image downloads; complete the Opera GX and webhook checks below. Every lifecycle command also holds `.runtime/lifecycle.lock`; if a crash leaves it behind, confirm no harness command is running before removing only that lock. n8n is bound locally at `127.0.0.1:${N8N_LOCAL_PORT}`; ngrok's inspector is bound at `127.0.0.1:${NGROK_INSPECTOR_PORT}`. Both port settings reject Relmio's reserved port `10531`.

Only n8n and ngrok share the edge network. n8n, the Sandbox API, and optional SearXNG share a private backend network; the certificate bootstrap and privileged runner use a separate runner network. The runner never mounts the host Docker socket. Sandbox ports `8080`, `9090`, and `9091`, and SearXNG port `8080`, have no host publication and are never routed by ngrok. The runner network intentionally retains outbound access so it can pull the pinned nested sandbox image.

`config` uses generated policy, secret, and search-settings material only for Compose validation and removes it afterward when this checkout has no ownership marker, so a dry validation leaves no Basic Auth or Assistant secret on disk.

## Acceptance in Opera GX

1. Open `https://<NGROK_DOMAIN>` in Opera GX and enter the public Basic Auth username and password from `.env`.
2. Complete n8n's disposable owner setup and confirm the editor loads over HTTPS.
3. Create a temporary Webhook workflow, listen for its test event, and call the displayed HTTPS test URL from an HTTP client that can send the same Basic Auth credential. Confirm the execution arrives in n8n, then delete the workflow.
4. In an enabled Assistant mode, configure your user-owned model provider directly in n8n. The harness wires the private Sandbox URL/key and optional SearXNG URL by environment; it never collects a model-provider API key.
5. Ask the Assistant to build one harmless workflow that exercises the Code Sandbox, then run the generated workflow. API health alone does not prove a nested sandbox execution.
6. In `sandbox-with-searxng` mode, run one web-research request and separately confirm `http://relmio-searxng:8080/search?q=n8n&format=json` returns a JSON object with a `results` array from inside the Docker backend. Treat every search result as untrusted prompt injection input.
7. Do not weaken or remove Basic Auth for webhook providers that cannot send it. Use a test client that supports Basic Auth instead.

`N8N_WEBHOOK_URL` and `N8N_EDITOR_BASE_URL` are set to the reserved HTTPS domain, with one trusted proxy hop as described by n8n's current [reverse-proxy webhook guidance](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/configuration-examples/configure-webhook-urls-with-reverse-proxy/).

## Exact cleanup

Run:

```sh
node harness.mjs down
```

The command verifies `.runtime/owner.json` matches this canonical checkout, derived project, and recorded Assistant mode before invoking that project's `down --volumes --remove-orphans` with the same profiles. A missing, malformed, permissive, or mismatched marker fails closed before Docker runs. Successful cleanup removes the disposable containers, all three project networks, n8n data and sandbox TLS volumes, password-bearing policy, generated Assistant secrets/settings, and marker. It never runs a global Docker prune.

If `up` fails or is interrupted, it deliberately preserves the marker, policy, containers, and volume for diagnosis and reports this same exact cleanup command. After inspection, run `node harness.mjs down`; do not substitute a manually guessed project name.

## Proof boundary

This harness tests a standalone n8n editor and webhook round-trip through ngrok, plus the selected local Assistant companion topology. It **does not prove the Relmio SSH installer path**, remote discovery, production installation, or cleanup. Static config and API health do not prove a real Assistant response, nested code execution, SearXNG result quality, or public ngrok reachability. Port `10531` and all Relmio endpoints are never exposed. No live Docker, ngrok, n8n, or Opera GX verification is claimed by these files alone.
