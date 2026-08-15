# Security and limitations

The VPS/n8n path handles a ChatGPT OAuth credential and an SSH authentication
method. The local endpoint path can additionally handle an OpenAI Platform API
key, a Codex/ChatGPT session, and generated local capabilities. Treat every one
of these values as password-equivalent. Read this page before offering the
wizard to another person.

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
- All three long-running endpoint containers run as a non-root user, drop Linux
  capabilities, set `no-new-privileges`, use a read-only root filesystem, and
  have bounded temporary storage and resource limits.
- The one-shot OpenAI credential seed helper is the narrow exception: it has no
  network, port, or logs; runs with a read-only root filesystem and strict
  resource limits; and uses root plus only `CHOWN` long enough to atomically
  make the stdin-seeded volume entry readable by the non-root gateway.

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
