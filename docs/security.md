# Security and limitations

This project handles two password-equivalent secrets: a ChatGPT OAuth
credential and an SSH authentication method. Read this page before offering
the wizard to another person.

## Trust model

The design assumes:

- the local computer is trusted;
- the VPS and its root account are trusted;
- other containers on the selected Docker network are trusted;
- the pinned `openai-oauth` and `ssh2` dependencies are acceptable for
  personal experimental use.

If any of those assumptions is false, do not use this design.

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

This repository does not claim that every possible use of the bridge is
permitted. The account owner is responsible for reviewing the current
[OpenAI Terms](https://openai.com/policies/terms-of-use/) and usage policies.

## Dependency policy

The current release pins:

- Node.js 22+
- `ssh2` `1.17.0`
- `openai-oauth` `2.0.0`

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
