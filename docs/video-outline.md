# YouTube walkthrough outline

This outline explains the project without overstating what the unofficial
OAuth bridge provides. Adjust the timing to match your recording.

## Suggested title

> Relmio: connect self-hosted n8n to a private OpenAI-compatible OAuth sidecar

Avoid titles that promise a free API key, unlimited usage, or guaranteed
credits. This project does not create an OpenAI Platform API key.

## Seven-minute structure

### 0:00 — The problem

- n8n's OpenAI credential expects an API key and supports a custom Base URL.
- You already have a self-hosted n8n Docker deployment.
- You want a private, experimental bridge without editing or restarting n8n.

On screen: the README warning and the final architecture diagram.

### 0:40 — The safety promise

- The wizard runs on the user's own computer.
- It creates a second Docker Compose project.
- It never edits the n8n Compose file or image.
- It never publishes sidecar port `10531`.
- It requires an SSH fingerprint check and final plan approval.

On screen: the **Sidecar-only guarantee** and Step 4 review screen.

### 1:30 — Why the design works

Use this simple explanation:

> n8n sends an OpenAI-shaped request to a private Docker hostname. The
> sidecar translates that request into the upstream OAuth-authenticated flow
> and returns an OpenAI-compatible response. Docker networking keeps the
> endpoint between containers instead of publishing it on the internet.

On screen: the Mermaid flowchart in the README.

### 2:20 — Start the npm package

Run locally:

```bash
npx --yes --ignore-scripts relmio@latest
```

Explain that:

- `npx` downloads and runs the published version for this session;
- the wizard binds to `127.0.0.1`;
- the printed setup URL is private and temporary;
- the terminal must remain open until the wizard finishes.

### 2:55 — Sign in and verify freshness

- Complete the newest ChatGPT sign-in page.
- Temporarily disable an OAuth browser extension only if it intercepts the
  `localhost:1455` callback.
- Show the **Credential updated** timestamp.
- Explain that the wizard uses
  `~/.n8n-openai-oauth/auth.json`, not `~/.codex/auth.json`.

Never show the auth file, browser session URL, cookies, or account details.

### 3:40 — Connect to the VPS safely

- Enter the complete address and SSH port.
- Check the SHA-256 fingerprint before the password field unlocks.
- Explain that the password is used only for the live SSH connection and is
  not saved.

Blur or replace the real address, fingerprint, username, and provider account
details in the recording.

### 4:25 — Detect n8n and approve the plan

- Select the running n8n container.
- Select the network shared with the sidecar.
- Read the **will** and **will not** columns.
- Approve the exact plan.

Emphasize that discovery is read-only and remote writes begin only after
approval.

### 5:15 — Configure n8n

Use:

```text
API Key: local-only
Organization ID: leave empty
Base URL: http://n8n-openai-oauth:10531/v1
Add Custom Header: off
```

Then add an OpenAI Chat Model to the AI Agent or Basic LLM Chain. For Chat
Model node version 1.3, keep **Use Responses API** on. If the switch is absent,
use the earlier node version's default Chat Completions behavior. Test one
simple prompt before adding tools. The model list depends on the signed-in
account and may change.

### 6:10 — Refresh and troubleshoot

- Run the same `@latest` command to refresh a session or update the
  wizard-managed sidecar.
- If n8n cannot connect, check the shared network and exact Base URL.
- If sign-in expires, close the old tab and begin again from the active
  wizard.
- If SSH fails, verify the address, port, firewall, password, and fingerprint.

Point viewers to [Troubleshooting](troubleshooting.md).

### 6:45 — Close with the limitations

- This is unofficial and experimental.
- It does not create an OpenAI Platform API key.
- ChatGPT and OpenAI API billing are separate products.
- Eligibility, models, and rate limits can change.
- Users must protect the OAuth credential and follow current terms.

## Recording safety checklist

- Use a disposable or sanitized demo VPS.
- Use a reserved documentation address such as `192.0.2.10` in mock screens.
- Hide browser address bars containing wizard session tokens.
- Never open or print `auth.json`.
- Never record an SSH password, private key, cookie, passkey prompt, or 2FA
  code.
- Blur real fingerprints, hostnames, account email addresses, and workflow
  data.
- Confirm that port `10531` has no host mapping.
- Show the version used in the recording:

  ```bash
  npm view relmio version
  ```

## Reference links for the description

- [`openai-oauth` v2.0.0](https://github.com/EvanZhouDev/openai-oauth/releases/tag/v2.0.0)
- [n8n OpenAI credential documentation](https://docs.n8n.io/integrations/builtin/credentials/openai/)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [OpenAI: using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)

Add the final video URL to the README only after the video is published. Do
not invent or reuse an unrelated tutorial link.
