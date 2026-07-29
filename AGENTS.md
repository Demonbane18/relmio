# Project: PlanRelay

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
