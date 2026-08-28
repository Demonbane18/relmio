# VPS and n8n

Relmio installs a separate sidecar project at
`/docker/n8n-openai-oauth`. It does not edit, rebuild, recreate, stop, or
restart your existing n8n Compose project or image. The sidecar has no host
port: n8n reaches it over the shared Docker network at
`http://n8n-openai-oauth:10531/v1`.

## Wizard route

1. Run the local wizard and complete the fresh ChatGPT sign-in on your own
   computer.
2. Enter your VPS address and compare the presented SSH host fingerprint with
   your provider before authorizing password authentication.
3. Select an already-running n8n container and one of its existing shared
   networks.
4. Review the exact plan. Remote writes begin only after final confirmation.
5. In n8n, use the private sidecar hostname rather than `127.0.0.1`.

The n8n credential's required API-key field uses `local-only` only as a UI
placeholder; it is not an OpenAI Platform API key.

## Follow-on guides

- [AI Assistant companion](./ai-assistant.md) covers the separate Preview
  sandbox, Docker-in-Docker warning, optional SearXNG search, and the direct
  OpenAI Platform-key model route.
- [Configure n8n nodes](./n8n-configuration.md) has copy-ready AI Agent and
  HTTP Request recipes.
- [Beginner manual installation](./manual-install.md) is the auditable fallback
  when the wizard cannot be used.
- [Troubleshooting](./troubleshooting.md) includes connection, Docker-network,
  and browser sign-in recovery steps.
