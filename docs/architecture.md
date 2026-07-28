# Architecture and n8n safety boundary

## Design

The wizard runs on the user's computer. It authenticates locally, opens one
verified SSH connection, performs read-only discovery, shows a plan, and then
creates a separate sidecar project on approval.

```mermaid
flowchart LR
  B["Local browser<br>127.0.0.1"] --> W["Local Node wizard"]
  W --> O["ChatGPT/Codex OAuth login<br>local callback"]
  W -->|verified SSH + SFTP| V["VPS"]
  V --> N["Existing n8n container<br>unchanged"]
  V --> S["New openai-oauth sidecar"]
  N -->|Docker DNS<br>n8n-openai-oauth:10531| S
  S --> C["OpenAI service used by<br>the upstream helper"]
```

## Why this integration is possible

The design combines four existing interfaces rather than changing n8n:

1. The n8n OpenAI credential accepts a custom Base URL.
2. The pinned bridge implements OpenAI-compatible model, Responses, and chat
   completions routes.
3. Docker Compose can attach a separate project to an existing external
   network.
4. Docker DNS resolves the private sidecar hostname from the n8n container.

n8n therefore talks to the private sidecar with its normal OpenAI request
shape. The sidecar handles upstream OAuth authentication with its mounted
credential. No OpenAI Platform API key is created.

## The mutation boundary

The installer can write only:

```text
/docker/n8n-openai-oauth/
├── .managed-by-n8n-openai-oauth
├── Dockerfile
├── docker-compose.yml
└── auth/
    └── auth.json
```

Its deployment commands always include:

```text
--project-name n8n-openai-oauth
--file /docker/n8n-openai-oauth/docker-compose.yml
```

The only service passed to `build` or `up` is `openai-oauth`, and `up` includes
`--no-deps`.

## Existing n8n operations

| Operation | Wizard behavior |
|---|---|
| Read running container list | Allowed |
| Read n8n network names | Allowed |
| Run a command inside n8n | Not used during installation |
| Edit n8n Compose | Forbidden |
| Build n8n image | Forbidden |
| Restart or stop n8n | Forbidden |
| Recreate or remove n8n | Forbidden |
| Publish a new VPS port | Forbidden |
| Add a Traefik route | Forbidden |

## Why the Base URL uses a service name

Docker Compose can attach a separate project to an existing external network.
Containers on that network can use Docker DNS to reach a service by name.
That is why n8n uses:

```text
http://n8n-openai-oauth:10531/v1
```

It must not use `127.0.0.1`, and the VPS does not need a public port. See
[Docker's external-network documentation](https://docs.docker.com/compose/how-tos/networking/#use-an-existing-network).

## Request paths

The n8n OpenAI credential validates with:

```text
GET /v1/models
```

The OpenAI Chat Model can use:

```text
POST /v1/responses
```

The compatibility path is:

```text
POST /v1/chat/completions
```

The placeholder API key satisfies n8n's required credential field. The
sidecar authenticates upstream with the mounted OAuth file.

## Technical sources

- [`openai-oauth` v2.0.0 server routes](https://github.com/EvanZhouDev/openai-oauth/blob/v2.0.0/packages/openai-oauth/src/server.ts)
- [`openai-oauth` v2.0.0 login flow](https://github.com/EvanZhouDev/openai-oauth/blob/v2.0.0/packages/openai-oauth/src/login.ts)
- [n8n OpenAI credential documentation](https://docs.n8n.io/integrations/builtin/credentials/openai/)
- [n8n OpenAI credential source](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/credentials/OpenAiApi.credentials.ts)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Docker Compose `expose`](https://docs.docker.com/reference/compose-file/services/#expose)
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)

## Failure behavior

- Invalid host, port, username, container, or network names are rejected.
- A changed SSH fingerprint blocks authentication.
- An existing unmanaged install directory is not overwritten.
- Invalid OAuth JSON is rejected before Docker changes.
- A failed Compose validation stops before build.
- A failed build or start does not trigger an n8n action.
- An unexpected host-port mapping causes verification to fail.
- The SSH connection closes after installation or when the wizard stops.
