# VPS and n8n

Relmio adds a sidecar at `/docker/n8n-openai-oauth`. It does not edit, rebuild,
recreate, stop, or restart your n8n Compose project or image. n8n reaches the
sidecar on its Docker network at `http://n8n-openai-oauth:10531/v1`. The
sidecar has no host port.

This bridge is unofficial, private, and policy-uncertain. ChatGPT sign-in is
not an OpenAI Platform API key.

## Use the wizard

1. Start Relmio and complete ChatGPT sign-in on your own computer.
2. Compare the shown SSH host fingerprint with your provider before you enter
   a password.
3. Select a running n8n container and one existing Docker network.
4. Review the plan and confirm it before Relmio writes anything remotely.
5. In n8n, use the sidecar service name, not `127.0.0.1`.

Use `local-only` only in n8n's required API-key field. It is a placeholder,
not an OpenAI Platform API key.

## Next guides

- [Configure n8n nodes](./n8n-configuration.md)
- [AI Assistant companion](./ai-assistant.md)
- [Manual installation](./manual-install.md)
- [Troubleshooting](./troubleshooting.md)
