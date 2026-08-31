# Security and limitations

The VPS/n8n path handles a ChatGPT OAuth credential and an SSH authentication
method. The local endpoint path can additionally handle an OpenAI Platform API
key, a Codex/ChatGPT session, and generated local capabilities. Treat every one
of these values as password-equivalent. Read this page before offering the
wizard to another person.

## ChatGPT/Codex sign-in lifetime

ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes
them automatically during active use before they expire, so active sessions
usually continue without another browser login. The official [OpenAI
authentication documentation](https://learn.chatgpt.com/docs/auth) does not
publish a fixed 10-day lifetime; do not plan around one. This provider
credential is separate from Relmio's local capability, which remains valid
until you rotate it.

## Trust model

The design assumes:

- the local computer is trusted;
- the VPS and its root account are trusted;
- other containers on the selected Docker network are trusted;
- the pinned `openai-oauth` and `ssh2` dependencies are acceptable for
  personal experimental use.

If any of those assumptions is false, do not use this design.

For a local Docker endpoint, the design additionally assumes:

- the local computer, operating-system account, and Docker Engine are trusted;
- the app receiving the Relmio capability displayed once by the wizard is
  trusted and controlled
  by the same person;
- a browser origin allowlist is not being used as a substitute for secret
  storage; and
- a raw Codex client is trusted with App Server's broad agent and account
  surface, while the Chat Adapter bearer is held only by a trusted local
  backend or development server.

The raw Codex App Server is not a multi-user boundary. It is for a trusted
native client owned by the same account holder, not a browser, shared service,
public app, or untrusted plugin.

The Codex Chat Adapter is a separate, narrower contract. It is for a trusted
local backend or development server owned by the same account holder. Browser
JavaScript must not call it directly, and it is not for a remote, hosted,
shared, or production service.

## Controls implemented by the wizard

- The web server binds only to `127.0.0.1`.
- Every API request needs a random 256-bit session token.
- POST requests must have the exact localhost origin.
- Browser responses disable caching, framing, cross-origin access, and
  unnecessary permissions.
- Request bodies and remote command output have size limits.
- Login, fingerprint, and connection attempts are rate-limited.
- The password field unlocks only after the SSH fingerprint is confirmed.
- The server binds that confirmation to the exact normalized host and port.
- Passwords are request-scoped, never saved, never logged, and cleared from
  the page immediately after the connection attempt.
- ChatGPT login is written first to a unique pending file, validated, and then
  stored at `~/.n8n-openai-oauth/auth.json` with owner-only permissions. The
  Codex app credential at `~/.codex/auth.json` is not reused or overwritten.
- OAuth JSON is validated and transferred through SFTP, never interpolated
  into a shell command.
- Remote paths are restricted to `/docker/n8n-openai-oauth`.
- Docker names are allowlisted before they can enter a command.
- Generated mutation commands come from a closed static allowlist.
- The sidecar runs as user `node`, drops all Linux capabilities, uses
  `no-new-privileges`, and has a read-only root filesystem.
- There is no host `ports` mapping and no reverse-proxy route.
- The installer verifies the absence of a published port after startup.

### Local endpoint controls

- The local browser wizard's `n8n-openai-oauth` option is a distinct
  Docker-network-only sidecar contract, not one of the loopback endpoints. It
  binds a single-use reviewed plan to the exact running n8n container,
  existing network, local Docker socket, and OAuth credential generation, then
  re-attests them before mutation.
- The local n8n sidecar publishes no host port and has no reverse-proxy labels.
  Relmio attaches only the new sidecar to the selected existing network and
  never edits, executes inside, rebuilds, restarts, stops, recreates, or changes
  network membership on n8n.
- The local n8n bridge is create/remove-only in this release. Relmio refuses an
  in-place reinstall before Docker mutation so a failed refresh cannot remove
  a previously working bridge or its private OAuth volume.
- The separate `n8n-ai-assistant` option always installs Code Sandbox and adds
  SearXNG only after an explicit boolean opt-in. Its privileged
  Docker-in-Docker runner is for local development and testing, not production;
  use Daytona for the production sandbox boundary.
- Assistant services use exact ownership labels and generated identities,
  attach only to the reviewed existing Docker network, and publish no host port
  or reverse-proxy route. Relmio returns the sandbox key and n8n settings once,
  but never changes or restarts n8n and never handles its model-provider key.
- The separate **New local n8n + ngrok** option creates only a new randomly
  identified Relmio-owned Compose project. It never adopts or changes an
  existing n8n. Its explicit public exception is limited to the new n8n route,
  protected by an ngrok Traffic Policy Basic Auth challenge; local n8n and the
  inspector bind to `127.0.0.1`, and optional Assistant services publish no
  host port or ngrok route. Removal requires exact marker and project-wide
  resource-label attestation before deleting the owned disposable data volume.
- Validated OAuth JSON is copied server-side over stdin into a private labeled
  volume by a network-disabled, logging-disabled helper. The source credential
  file is preserved and neither its path nor contents are returned to the
  browser, written into Compose/environment values, or included in errors.
- Generated Compose files publish only literal
  `127.0.0.1:<selected-port>:<container-port>` mappings.
- Every OpenAI `/v1` operation that can reach OpenAI, every raw Codex WebSocket
  upgrade, and every Codex Chat Adapter route except `GET /health` requires a
  random Relmio capability displayed once by the wizard; only its SHA-256
  verifier is persisted. Exact-origin CORS `OPTIONS` is a non-forwarding
  exception only for the Platform-backed `/v1` gateway. The bearer remains
  valid until an endpoint update rotates it.
- The Platform API key is accepted only for the OpenAI gateway. A transient,
  network-disabled helper receives it over stdin and atomically seeds a private,
  labeled Docker volume that the gateway mounts read-only. No host key file or
  Compose environment value is created, and the key is never returned to the
  browser after installation.
- ChatGPT sign-in is accepted only through the official Codex App Server
  account flow. Relmio never returns or converts the resulting tokens.
- Browser requests to the OpenAI gateway require an exact configured `http`
  or `https` origin. Wildcards and `null` are rejected; requests without an
  `Origin` remain available to authenticated native clients and backends.
- The Chat Adapter rejects every request carrying an `Origin` header, emits no
  CORS permission, and exposes only its authenticated Relmio-specific
  `POST /chat` contract plus readiness and credential-verification probes.
- Each Codex target receives its own private named credential and workspace
  volumes. No long-running local endpoint service mounts a host directory,
  Docker socket, SSH key, browser profile, or host home directory.
- Chat Adapter turns use a named read-only permission profile with network
  disabled. Its model-visible filesystem policy denies root by default, allows
  only Codex's minimal runtime paths and the empty private workspace, and
  explicitly denies the persisted Codex credential store.
- Local managed paths use mode `0700`, generated files use owner-only modes,
  symlinks are rejected, and existing unmanaged directories are not
  overwritten.
- The selected Docker context must resolve to a local Unix socket. Every
  mutating command is pinned to that socket, Docker selector environment
  overrides are removed, and native Windows is rejected before mutation.
- Each install uses a random Compose project identity. Containers, networks,
  and volumes must carry matching Relmio ownership labels before update,
  restart, recovery, or sign-in actions are allowed.
- All three long-running loopback endpoint containers run as a non-root user, drop Linux
  capabilities, set `no-new-privileges`, use a read-only root filesystem, and
  have bounded temporary storage and resource limits.
- The one-shot OpenAI credential seed helper is the narrow exception: it has no
  network, port, or logs; runs with a read-only root filesystem and strict
  resource limits; and uses root plus only `CHOWN` long enough to atomically
  make the stdin-seeded volume entry readable by the non-root gateway.

### AI Assistant companion image integrity

The generated AI Assistant companion uses reviewed, immutable
`tag@sha256:<OCI-index-digest>` image references for its API/certificate image,
privileged runner, nested sandbox image, and optional SearXNG service. The
Compose format cannot enforce image provenance itself, so the source-level
regression guard forbids floating or digestless production references,
including the nested `SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE` value.

There is no automatic remote upgrade. An upgrade or rollback is a separately
confirmed managed companion update after read-only discovery and exact-plan
review; it must preserve the no-n8n-mutation boundary, ownership attestation,
and no-host-port verification. See the exact procedure in
[maintenance.md](maintenance.md#updating-or-rolling-back-ai-assistant-companion-images).

### In-wizard Chat Adapter tester

The Ready screen's Chat Adapter tester is a deliberately narrow convenience
path, not a browser CORS exception. Its browser calls stay same-origin to the
setup-token-protected wizard. Only the local wizard server calls the adapter,
using a server-side `POST /chat` request without an `Origin` header.

The tester accepts only a literal `http://127.0.0.1:PORT` base URL and appends
`/chat` itself. It refuses `localhost`, IPv6, LAN/private/public addresses,
credentials, query strings, fragments, redirects, malformed JSON, oversized
payloads, excessive IDs/ciphertext, concurrent key use, and preview mode. The
server bounds timeout and response size, validates the upstream shape, and
returns only a conversation ID plus output with generic redacted errors.

Before a test, the browser obtains an ephemeral RSA-OAEP SHA-256 public key
from the local wizard, clears the credential input, and retains only ciphertext
and key ID in page memory. The matching private key remains only in the local
server's in-memory, time-limited, bounded session map and can be invalidated
explicitly. Prompts and transcript are not persisted server-side.

This is not encryption at rest or end-to-end encryption. It reduces accidental
credential transit and storage exposure, but cannot protect a compromised
browser, extension, or local machine.

## What “private” means here

Port `10531` is not reachable from the public internet or VPS host through a
Docker port mapping. It is reachable by containers attached to the selected
Docker network.

The bridge must listen on `0.0.0.0` inside its container so n8n can reach it.
The upstream warning about a non-loopback host is therefore expected. The
protection is the absence of `ports:` and Traefik labels.

Do not attach untrusted containers to the same Docker network.

## Credential consequences

The copied `auth.json` lets the sidecar act through your ChatGPT account. A
root compromise of the VPS, Docker socket access, or a compromised sidecar can
expose it.

- Never commit `auth.json`.
- Never paste it into issues, logs, screenshots, or chat.
- Do not share one account across customers or users.
- Do not expose the bridge on a domain or public IP.
- Revoke or refresh the session if the VPS may be compromised.
- Prefer a dedicated personal VPS with current security updates.

The local capabilities have separate consequences:

- The OpenAI gateway capability can spend through the protected Platform API
  key, subject to that Platform project's permissions and limits.
- The raw Codex App Server capability can invoke broad App Server methods
  inside its isolated container and use its signed-in ChatGPT/Codex session.
- The separate Chat Adapter bearer can submit chat turns and resume its bounded
  conversation threads through the signed-in Codex container. Its narrower
  HTTP surface and model permission profile reduce access, but do not make the
  bearer safe to expose or share.
- An origin allowlist does not make a bearer embedded in browser JavaScript
  private. The Chat Adapter rejects browser origins entirely; keep its bearer
  in a trusted local backend or development server.
- Do not expose any local endpoint on a LAN, public IP, domain, reverse proxy, or
  hosted service. Loopback binding and the bearer capability are both required.
- If a capability is disclosed, update the endpoint to rotate it. If an
  upstream credential may be exposed, revoke or sign out through the provider
  as well.

## Product and policy limitations

- This is not an OpenAI Platform API key.
- A ChatGPT subscription does not normally include OpenAI API credits;
  [OpenAI documents the billing separation here](https://help.openai.com/en/articles/8156019-i-want-to-move-my-chatgpt-subscription-to-the-api).
- The bridge is unofficial and can stop working when upstream behavior changes.
- Models depend on the ChatGPT plan and can change without a project release.
- The bridge's Responses endpoint is stateless and expects full conversation
  history from the caller.
- Rate limits and account restrictions still apply.
- OpenAI can change or discontinue service behavior and can suspend access for
  Terms or usage-policy violations.
- The local OpenAI-compatible endpoint requires a Platform API key. Its usage
  is billed or credited to the associated Platform project; a ChatGPT
  subscription or Codex for Open Source benefit is not substituted for API
  billing.
- The raw local Codex option preserves the official App Server JSON-RPC protocol.
  It does not provide `/v1/chat/completions`, `/v1/responses`, or any other
  OpenAI API compatibility route.
- OpenAI documents App Server WebSocket transport as experimental and
  unsupported for production. It rejects browser-origin requests and is
  limited here to trusted native same-owner clients.
- The Codex Chat Adapter uses the official App Server lifecycle internally but
  exposes only Relmio's experimental `POST /chat` contract. It is not
  `/v1/chat/completions`, `/v1/responses`, or an OpenAI SDK replacement; it
  rejects browser origins and is limited to trusted local backends or
  development servers.
- Acceptance into Codex for Open Source is not treated by Relmio as permission
  to repurpose credentials, share an account, bypass controls, or broaden the
  scope of another agreement. Review the current
  [program terms](https://learn.chatgpt.com/docs/codex-for-oss-terms).

### Policy evidence and scope

The following sources support the narrow provider and authentication patterns
that Relmio documents. They are not a blanket approval of Relmio, a substitute
for the current agreements governing an account, or legal advice.

| Evidence | What it supports | What it does not establish |
| --- | --- | --- |
| Maintainer acceptance (private OpenAI email, August 2026) and the [Codex for Open Source Program Terms](https://learn.chatgpt.com/docs/codex-for-oss-terms) | Relmio's maintainer was accepted into the program for this project and received a limited-duration ChatGPT Pro benefit covering Codex access. The program is designed to support maintainers of important open-source software. | Program acceptance supports the maintainer and open-source work. It is not an OpenAI security review, product endorsement, or protocol-by-protocol compliance certification. The acceptance email is not published because it contains personal account information. |
| OpenAI's [Advanced Configuration — OSS mode and local providers](https://learn.chatgpt.com/docs/config-file/config-advanced#oss-mode-local-providers) | Codex supports custom model-provider configuration and an OSS mode with local providers such as Ollama or LM Studio. | It does not authorize turning a ChatGPT subscription credential into a general API credential or bypassing provider restrictions. |
| [Thibault “Tibo” Sottiaux](https://openai.com/index/openai-to-acquire-astral/), Codex Lead at OpenAI: [open-model statement](https://x.com/thsottiaux/status/2067399435009622521) | The Codex App, CLI, and SDK can run with open-source models rather than only OpenAI models. | Model-provider flexibility does not change authentication, billing, account, or usage-policy requirements. |
| Tibo: [account-use statement](https://x.com/thsottiaux/status/2090675027670978569) | Using one's own subscription through **Sign in with ChatGPT**, including compatible open-source clients, was distinguished from unsupported conversion of subscription access into API traffic. | It does not approve resale, pooling, forwarding credentials, sharing across users, or subscription-to-API conversion. A social post is not a contractual amendment. |
| OpenAI CEO Sam Altman: [OpenClaw statement](https://x.com/sama/status/2050357911915028689) | OpenClaw was publicly announced as supporting ChatGPT-account sign-in and subscription use. | Approval of one named integration does not automatically approve unrelated protocols, adapters, deployments, or credential handling. |

Relmio applies these distinctions as engineering controls:

- Native Codex uses the official Codex App Server lifecycle and preserves its
  protocol instead of exporting a generic OpenAI `/v1` service.
- The bounded Codex Chat Adapter remains an experimental Relmio-specific
  interface for the same owner; it is not an OpenAI API replacement.
- The n8n AI Assistant model route uses a user-owned OpenAI Platform project
  and API key entered directly in n8n. Relmio never receives that key.
- The legacy n8n OAuth sidecar remains explicitly
  experimental/private/policy-uncertain and is not described as approved by
  the sources above.
- Relmio prohibits account sharing, pooling, resale, subscription-to-API
  conversion, rate-limit or safeguard bypass, and credential forwarding.

This repository does not claim that every possible use of the bridge is
permitted. The account owner is responsible for reviewing the current
[OpenAI Terms](https://openai.com/policies/terms-of-use/) and usage policies.
The local endpoint design follows the documented
[OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication),
[Codex authentication](https://learn.chatgpt.com/docs/auth), and
[Codex App Server](https://learn.chatgpt.com/docs/app-server) boundaries. This
is engineering guidance, not legal advice or an OpenAI approval.

## Dependency policy

The current release pins:

- Node.js 22+
- `ssh2` `1.17.0`
- `openai-oauth` `2.0.0`
- `@openai/codex` `0.147.0` in the local Codex image

The POSIX and native Windows PowerShell bootstraps reuse a compatible local
Node.js runtime or download the matching current official Node.js 22 archive
to a private temporary directory. Each validates the archive against Node.js's
SHA-256 manifest before execution and removes it when the wizard closes. The
PowerShell bootstrap accepts only strict Windows x64 or ARM64 archive names,
uses HTTPS without redirects, and enables TLS 1.2 for Windows PowerShell 5.1.
npm lifecycle scripts are disabled when either bootstrap starts Relmio. The
generated sidecar also installs `openai-oauth` with `--ignore-scripts`.

Do not replace pinned versions with `latest` in production. Follow the upgrade
checklist in [maintenance.md](maintenance.md).

## Reporting a security problem

Do not open a public issue containing a token, password, private IP, hostname,
workflow data, or unredacted log. Revoke exposed credentials first, then share
only a sanitized reproduction with the repository owner.
