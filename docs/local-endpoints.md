# Local Docker endpoints

Relmio can install a provider endpoint in Docker on the same computer as your
app. The local installer is deliberately split into two protocols with two
different authentication methods:

| Wizard option | Local interface | Upstream sign-in | Intended client |
|---|---|---|---|
| **OpenAI API: compatible clients** | OpenAI-compatible HTTP under `/v1` | Server-side OpenAI Platform API key only | A private local app, SDK, or same-owner development web app |
| **Codex with ChatGPT: agent clients** | Official Codex App Server JSON-RPC over WebSocket | ChatGPT sign-in through Codex | A trusted native Codex/App Server client owned by the same person |

Relmio does not exchange or translate a ChatGPT OAuth/session credential into
an OpenAI-compatible `/v1` bearer credential. The Codex option keeps Codex's
thread, turn, approval, and streamed-event semantics instead of pretending to
be the OpenAI API.

This is a documentation-backed engineering boundary, not legal advice or a
guarantee that a particular account or use case is permitted. Review the
agreements and policies that apply to your account.

## Requirements

- macOS, Linux, or Linux under WSL2. Native Windows is not supported because
  this release depends on POSIX owner-only directory and file permissions for
  local credentials.
- Docker Engine or Docker Desktop with Docker Compose v2 on the local computer
- A free loopback port (`12435` by default for OpenAI API or `14500` for Codex)
- One of these provider credentials:
  - an OpenAI Platform API key for the OpenAI-compatible endpoint; or
  - a ChatGPT account eligible for Codex for the App Server endpoint
- A trusted local app that can keep the Relmio capability secret

The local path does not need a VPS or SSH access and does not modify the
existing n8n deployment. It creates a separate Relmio-managed Docker Compose
project on the local computer.

## Install with the browser wizard

1. Start Relmio on the computer that will run the endpoint. Use one of the
   commands in the [README](../README.md#quick-install), or run:

   ```bash
   npx --yes --ignore-scripts relmio@latest
   ```

2. Open the one-time local wizard URL printed in the terminal and choose
   **Local endpoints**.
3. Choose **OpenAI API: compatible clients** or **Codex with ChatGPT: agent
   clients**.
4. Keep the default port or select another unused local port. For the OpenAI
   API option, add any browser origins that must be allowed and enter your
   Platform API key.
5. Review the exact bind address, managed path, protocol, and limitations.
   Confirm the plan before Relmio writes files or starts Docker.
6. Copy the generated local capability when the result screen displays it.
   Relmio shows the raw capability once and persists only its SHA-256 verifier.
   “Shown once” describes the wizard display; the bearer remains valid until
   you update the endpoint to rotate it.
7. If you selected Codex, complete the device-code sign-in shown by the wizard.

Relmio refuses to overwrite an existing unmanaged directory or use a symlink
inside its managed path. Its local files live under:

```text
~/.relmio/local/openai-api
~/.relmio/local/codex-chatgpt
```

Advanced or test environments can set `RELMIO_HOME` before starting the
wizard to an absolute managed base whose final component is `.relmio`.

Each target directory contains `.managed-by-relmio.json`. Its schema-2 marker
records the target, port, Docker socket URI, installation ID, and unique Compose
project name; it contains no credential. Relmio uses that identity to distinguish
its resources from another checkout or user's resources on the same Docker
Engine.

## Safe updates and credential rotation

To replace only the credential used by your local client, select **Rotate client
credential** on the installed endpoint's Ready screen. Relmio first stages and
shows the new one-time capability while the previous capability remains active.
It then updates and validates the managed Compose configuration, recreates only
the attested service, and verifies the new bearer against `/v1/models` or the
authenticated Codex WebSocket handshake before reporting success.

This client-only rotation preserves the upstream Platform API key in its private
named volume and preserves the Codex home and workspace volumes. If activation
or verification fails, Relmio restores the previous verifier and re-attests its
health and loopback publication. Relmio does not retain the previous raw client
credential, so rollback does not replay an authenticated request with it. If
that rollback cannot be confirmed, Relmio attempts to stop only the exact
managed service and reports whether the stopped state could be verified.

Rerun the browser wizard with the same target and port when you need a complete
managed update. Relmio verifies the marker and Docker resource ownership and
reuses the installation's unique Compose identity. For `openai-api`, provide the
current or replacement Platform API key during that full update; Relmio reseeds
its private named volume independently from the local client capability. A full
`codex-chatgpt` update retains the private Codex home and workspace volumes unless
you explicitly delete them.

Do not hand-edit the marker, Compose file, credential volume, or verifier. If
the marker or resource labels do not attest as one Relmio installation, the
wizard stops without overwriting them.

## OpenAI API: compatible clients

The result screen provides:

```text
Base URL: http://127.0.0.1:12435/v1
API key field: <the Relmio local capability shown once by the wizard>
```

Use the Relmio capability shown once by the wizard, not the upstream Platform
key, in your local
client's API-key field. The gateway authenticates the local request with that
capability, replaces its authorization header with the protected Platform key,
and forwards only `GET /v1/models`, `POST /v1/responses`, and
`POST /v1/chat/completions` to `https://api.openai.com`.

For a quick private test:

```bash
export RELMIO_LOCAL_KEY="<capability shown once by the wizard>"
curl http://127.0.0.1:12435/v1/models \
  -H "Authorization: Bearer $RELMIO_LOCAL_KEY"
```

The upstream key is passed only over stdin to a transient, network-disabled
seed helper, which atomically writes it into a private, labeled Docker volume.
The gateway mounts that volume read-only. Relmio does not create a host key
file, put the key in the generated Compose environment, return it from the
wizard, forward it from the client, or use it for the Codex option. OpenAI's
API documentation says API credentials are secrets and should not be exposed
in client-side code. Treat the local capability the same way.

### Browser origins

Native clients and local backends normally send no `Origin` header and can use
the endpoint after bearer authentication. A browser request is allowed only
when its exact `http` or `https` origin was entered during setup. For example,
`http://localhost:3000` and `http://127.0.0.1:3000` are different origins.

Relmio does not accept wildcard origins, `null`, credentials, paths, queries,
or fragments. An allowed origin is a cross-origin request control, not a
secret-storage system: JavaScript, browser extensions, or anyone who can read
the page can still recover a bearer value embedded in a frontend bundle. Use
browser access only for a private, same-owner local development app. Prefer a
native client or a local backend when the capability must remain confidential.

### Billing and credits

Requests use the OpenAI Platform project associated with the supplied API key
and are billed or credited there under the Platform account's current terms,
limits, and pricing. A ChatGPT subscription or Codex for Open Source benefit
is not substituted for Platform API billing on this route. OpenAI documents
API-key use as usage-based access and ChatGPT sign-in as subscription access in
its [Codex authentication guide](https://learn.chatgpt.com/docs/auth).

## Codex with ChatGPT: agent clients

The result screen provides:

```text
Endpoint: ws://127.0.0.1:14500
Authorization: Bearer <the Relmio capability shown once by the wizard>
Protocol: Codex App Server JSON-RPC
```

After installation, select the wizard's ChatGPT sign-in action, open the
official verification URL, enter the device code, and complete authentication.
Relmio starts the login through the official Codex App Server account method;
it never returns the resulting ChatGPT access or refresh tokens.

A compatible Codex CLI can connect like this:

```bash
export CODEX_REMOTE_TOKEN="<capability shown once by the wizard>"
codex --remote ws://127.0.0.1:14500 \
  --remote-auth-token-env CODEX_REMOTE_TOKEN
```

This is not an OpenAI `/v1` endpoint. A client must implement the official
App Server initialization and JSON-RPC protocol, including its thread, turn,
approval, and event messages.

### Experimental and high-trust boundary

OpenAI documents the App Server command and WebSocket transport as experimental
and unsupported for production workloads. The raw server rejects requests that
carry a browser `Origin` header, so it is not a direct browser/web-app endpoint.
Use it only with a trusted native client controlled by the same account owner.

Possession of the Relmio capability can grant access to App Server's broad
agent and account surface inside the container, including the signed-in Codex
session and files in its private workspace; a capable client may be able to
recover the container's ChatGPT session credential. Treat the capability like
the ChatGPT credential itself. Do not give it to another user, bundle it in an
app, or expose the WebSocket on a LAN, domain, reverse proxy, or public IP.

Relmio limits the effect of that access by giving Codex a private named Docker
workspace and credential volume. The service receives no host directory,
Docker socket, SSH key, browser profile, or host home-directory mount. This
reduces host exposure; it does not make an untrusted App Server client safe.

## Network and container boundary

Both local Compose projects publish exactly one host mapping:

```text
127.0.0.1:<selected-port>:<container-port>
```

They are not available through the computer's LAN address. Each long-running
service runs as a non-root user, drops Linux capabilities, sets
`no-new-privileges`, uses a read-only root filesystem, and has bounded
temporary storage and resource limits. Neither service mounts the Docker
socket or a general host directory. The one-shot OpenAI seed helper has no
network, port, or logs and retains only `CHOWN` while running as root long
enough to atomically set ownership on the volume entry.
The OpenAI gateway receives only its private API-key named volume, mounted
read-only; Codex receives no host path and uses separate private named volumes.

The loopback binding and capability are complementary controls. Other
processes running as the same local user may still be able to reach a loopback
port, so protect the capability and keep the computer itself trusted.

## Recovery and uninstall

The commands below are intentionally scoped to one persisted installation.
They are not safe until you verify ownership. First open, but do not execute or
shell-evaluate, the exact target's `.managed-by-relmio.json`. Manually copy its
literal values only after confirming all of these conditions:

- `schemaVersion` is `2` and `target` is the target you intend to operate on;
- `installId` is exactly 32 lowercase hexadecimal characters;
- `projectName` is exactly `relmio-<target>-<installId>`;
- `dockerHost` is a `unix:///absolute/socket/path` that you recognize; and
- the absolute Compose path is inside that same managed target directory, is
  not a symlink, and names `docker-compose.yml`.

In every example, manually replace each angle-bracket placeholder with the
already-validated literal. Do not use `eval`, source the JSON, or construct a
Docker command from unvalidated marker text. The only valid service name is
`gateway` for `openai-api` or `codex` for `codex-chatgpt`.

### Recover from a failed install

If Relmio reports that it could not confirm cleanup, keep the marker and
managed files in place. List only candidate containers, networks, and volumes
for the recorded installation:

```bash
docker --host <dockerHost> ps -a \
  --filter label=io.relmio.managed=true \
  --filter label=io.relmio.target=<target> \
  --filter label=io.relmio.install=<installId>
docker --host <dockerHost> network ls \
  --filter label=io.relmio.managed=true \
  --filter label=io.relmio.target=<target> \
  --filter label=io.relmio.install=<installId>
docker --host <dockerHost> volume ls \
  --filter label=io.relmio.managed=true \
  --filter label=io.relmio.target=<target> \
  --filter label=io.relmio.install=<installId>
```

Inspect every listed object individually, using its literal name or ID rather
than a wildcard:

```bash
docker --host <dockerHost> container inspect <literal-container-id>
docker --host <dockerHost> network inspect <literal-network-id>
docker --host <dockerHost> volume inspect <literal-volume-name>
```

Confirm all three labels—`io.relmio.managed=true`, the exact target, and the
exact installation ID—match the marker. If any label or identity differs,
stop. Only after they all match may you stop and remove the one managed
service:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  rm --stop --force <gateway-or-codex>
```

This recovery command does not target other services, remove the project
network, or delete volumes. After confirming the service is gone, rerun the
wizard and approve a fresh plan.

### Uninstall Codex while retaining its data

After the same marker and label verification, stop the target and remove its
container and project network with:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  down
```

Do not add `--volumes`. The named Codex home and workspace volumes retain the
ChatGPT login and workspace. Keep the managed target directory and marker as
well; they preserve the ownership identity needed to safely reuse or later
delete those volumes. Never remove the parent `~/.relmio`, use a wildcard, or
remove the other target.

### Permanently uninstall the OpenAI API endpoint

After repeating the OpenAI target's marker and label checks, delete its one
managed service, project network, and API-key volume with the exact
project-scoped command:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  down --volumes
```

For this target, `--volumes` irreversibly deletes the private volume containing
the Platform API key. After Docker confirms that every matching labeled
resource is gone, you may remove only the exact
`~/.relmio/local/openai-api` managed directory through your file manager.

### Permanently delete Codex credentials and workspace

Back up anything intentionally retained from the private Codex workspace and
confirm you want to erase its ChatGPT login. Then repeat the marker and label
checks and run this exact project-scoped command:

```bash
docker --host <dockerHost> compose \
  --project-name <projectName> \
  --file <absolute-managed-compose> \
  down --volumes
```

`--volumes` irreversibly deletes the managed Codex home and workspace volumes,
including the container's ChatGPT credentials. After Docker confirms the
matching resources are gone, you may remove only the exact
`~/.relmio/local/codex-chatgpt` managed directory through your file manager.

## Troubleshooting

- **Docker unavailable:** start Docker Desktop or the Docker daemon and verify
  `docker version` and `docker compose version` locally.
- **Port already in use:** choose another unprivileged port in the wizard and
  review the updated endpoint before confirming.
- **`401` from `/v1`:** use the Relmio capability shown by the wizard in the
  client's bearer/API-key field. Do not send the Platform key to the local
  endpoint.
- **Browser request rejected:** enter the exact page origin, including scheme
  and port, then update the managed endpoint. Wildcards are intentionally not
  supported.
- **Browser cannot connect to Codex:** this is expected. App Server's raw
  WebSocket is for trusted native clients, not browser-origin connections.
- **Codex reports signed out:** repeat the device-code sign-in in the local
  wizard. Never copy a Codex credential file between users.
- **Native Windows:** this local Docker feature is unsupported. Run Relmio in a
  POSIX environment such as WSL2, or use macOS/Linux; do not weaken credential
  permissions to force an install.

## Official sources and account terms

This design follows the currently documented distinction between Platform API
credentials and Codex/ChatGPT authentication:

- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex App Server protocol and WebSocket limitations](https://learn.chatgpt.com/docs/app-server)
- [Codex for Open Source program terms](https://learn.chatgpt.com/docs/codex-for-oss-terms)

Acceptance into Codex for Open Source can provide program benefits, but Relmio
does not interpret membership as permission to repurpose ChatGPT credentials
for general API calls, share an account, bypass safeguards, or alter the scope
of another OpenAI agreement. The local Codex option stays inside the official
Codex protocol; general `/v1` calls continue to require Platform credentials.
