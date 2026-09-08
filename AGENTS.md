# Project: Relmio

## Runtime

- Node.js 22 or newer
- npm 10.9.8
- ECMAScript modules
- Node's built-in HTTP server and test runner
- `ssh2` 1.17.0 for SSH and SFTP

## Commands

- Install: `npm ci --ignore-scripts`
- Start: `npm start`
- Test: `npm test`
- Lint: `npm run lint`
- Audit: `npm audit --audit-level=high`
- Package preview: `npm pack --dry-run`

## Conventions

- Communicate with the project owner in English, including voice sessions,
  unless the owner explicitly requests another language.
- Keep domain logic pure and inject SSH/file/process boundaries.
- Validate every value before it can enter a remote command.
- Use static remote commands wherever possible.
- Render untrusted status text with `textContent`, never `innerHTML`.
- Prefer named exports.

## Safety boundaries

- Never edit the existing n8n Compose file or image.
- Never rebuild, recreate, stop, or restart the n8n container.
- Never publish port `10531` on the VPS host.
- Never print, return, or commit OAuth tokens, SSH passwords, or private keys.
- Never deploy outside `/docker/n8n-openai-oauth`.
- Require SSH host-key confirmation before authenticated connection.
- Require a final human confirmation before remote writes.

## OpenAI source check for every update

Before accepting any Relmio update or upgrade, fetch the current official
[Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
and the official capability, authentication, Terms, and privacy documents that
apply to the changed flow. Compare them with the code and user disclosures.

Record the check date, source links, findings, and unknowns. State what Relmio
reads, stores, transmits, and logs, including OAuth scopes and every party that
receives data. Keep identity sign-in, separately approved permissions, and
model or TTS capability as distinct checks.

Do not treat the Help Center article or a successful OAuth login as blanket
Terms compliance, permission to use a Codex credential bridge, or proof that a
model or TTS feature is available. The article's identity-only description may
not match Relmio's flow; verify that match instead of assuming it.

Keep personal Obsidian notes and Graphify exports in a separate private
repository. Never include that vault in public Relmio commits, pushes, or npm
artifacts. When private ingestion is configured, refresh it after project
updates; ingestion does not substitute for the official-source review above.
