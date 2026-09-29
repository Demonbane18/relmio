# VPS and n8n

Relmio can add OAuth or local-model companions beside an existing n8n VPS. Each
companion uses the selected existing Docker network and has a separate endpoint
and lifecycle. SuperGrok does not require or read ChatGPT credentials.

| Connection | Private Base URL | n8n API-key field | Use Responses API |
| --- | --- | --- | --- |
| OpenAI OAuth with ChatGPT/Codex sign-in | `http://n8n-openai-oauth:10531/v1` | `local-only` placeholder | **On** in the Relmio OpenAI Chat Model v1.3 recipe |
| SuperGrok OAuth | `http://n8n-supergrok:14502/v1` | One-time local Relmio bearer | **Off** for workflow model nodes and Chat Hub |
| Local Ollama model | `http://n8n-local-model:11434/v1` | `local-only` ignored placeholder | **Off** for the documented Chat Completions recipe |

The OpenAI bridge is unofficial, private, and policy-uncertain. ChatGPT sign-in
is not an OpenAI Platform API key. The SuperGrok adapter is experimental and
uses a fresh official Grok device sign-in.

Relmio's managed files stay below `/docker/n8n-openai-oauth`; the safe,
root-owned `/docker` parent must already exist. Docker manages the companion's
approved images, containers and volumes in its own data root. Relmio does not
edit, rebuild, recreate, execute inside, stop, or restart your n8n Compose
project or image. No companion publishes a host port.

Confirmed build-capable actions also use temporary mode-`0700` Buildx client
state inside the reviewed operation lock: `.local-model-operation.lock/buildx`
for model install/retry, `.supergrok-operation.lock/buildx` for SuperGrok
install/sign-in/sign-out, and `.openai-oauth-operation.lock/buildx` for the
OpenAI bridge. All are beneath the managed root. Verified cleanup removes
owned temporary state only; ambiguous or interrupted cleanup retains the
lock for administrator inspection, not automatic deletion. Registry
credentials are not copied, moved or printed for this state.

The OpenAI bridge's `Dockerfile.dockerignore` permits only its Dockerfile and
runtime source in the build context, excluding `auth`, sibling companions and
temporary state. Relmio accepts an absent file or its exact safe owned version;
it does not overwrite an unknown operator-supplied ignore file.

The local-model companion is not a provider sign-in or an OpenAI API-key
connection. Ollama's API has no authentication by default, so any container on
the selected Docker network can reach its model-management API. Choose a
trusted network. It runs one CPU-based model and needs outbound internet to
download the runtime and model weights even though Ollama cloud features are
disabled. See [Private local models](local-models.md) and
[Hosting compatibility](hosting-compatibility.md).

## Use the wizard

In the experimental browser wizard, the five steps are **Choose setup**,
**Check server**, **Choose n8n**, **Review**, and **Ready**. The route chooser
appears before ChatGPT sign-in. Stable `@latest` and hosted installers remain
`0.17.5` and do not open this redesigned chooser.

1. Choose the ChatGPT route and complete ChatGPT/Codex sign-in on this computer
   before uploading the credential file. SuperGrok uses its own device sign-in
   after installation. **Local model · your VPS** needs no provider sign-in.
2. Enter the server address and port, then independently compare and confirm
   the SSH host fingerprint. Only after that, enter the actual SSH username
   and choose **Local SSH agent** or approved password authentication. Never
   upload a private key or enable root/password SSH just for this wizard.
3. Connect and check the verified administrative identity. OAuth bridge,
   SuperGrok and Assistant VPS operations require an already-approved
   direct-root connection; agent authentication does not change that privilege
   boundary. **Passwordless sudo -n (model only)** is limited to local-model
   management and common read-only discovery, not credential-bearing routes.
4. Select a running official n8n container and one eligible existing Docker
   network. Rootful Docker Engine, Compose v2 and Buildx must use the same
   local daemon in the selected administrative context; Podman, rootless or
   remote daemons, external build targets and managed PaaS service shells are
   not substitutes.
5. Review the exact account, privilege, resources and managed paths. For the
   OpenAI bridge, the displayed currently verified SSH identity names the
   destination for the complete credential file. Going back, changing or
   losing the verified identity clears review and approval. Final human
   confirmation is still required before any remote write. In n8n, use the
   matching private Base URL and Responses API setting from the table above,
   never `127.0.0.1`. Select **Disconnect from VPS** when finished.

See [Hosting compatibility](hosting-compatibility.md) for image-qualified
accounts on Hetzner, Contabo, AWS, DigitalOcean and OCI, local-agent setup,
the existing `/docker` prerequisite, and Render's separate manual private
service. A provider choice does not provision or repair the host.

Relmio also closes the authenticated SSH session after 15 minutes of
inactivity. An active VPS operation holds a bounded lease so discovery or an
approved install can finish before the idle timer resumes.

## Update an existing OpenAI bridge

Installing a newer Relmio package on your computer does not replace the bridge
already running on the VPS. Start a Relmio release that contains the bridge
compatibility update, then use the same browser wizard:

1. Run `relmio vps` and reconnect to the VPS.
2. Compare and confirm its SSH host fingerprint.
3. Select the n8n container and Docker network.
4. Choose **OpenAI-OAuth/Codex bridge**, then select **Manage
   OpenAI-OAuth/Codex bridge**.
5. Choose **Review bridge update** and review the exact sidecar-only plan.
6. Select the confirmation checkbox, then choose **Update the bridge**.

Relmio performs the SSH update from the browser flow, so no separate VPS
terminal is required. It uploads the current local ChatGPT sign-in, keeps the
selected network, rebuilds and verifies only the owned sidecar inside
`/docker/n8n-openai-oauth`, and publishes no host port. n8n remains untouched.

Use `local-only` only for the OpenAI bridge. It is a placeholder, not an OpenAI
Platform API key. SuperGrok uses the one-time local bearer shown by its wizard.

## Next guides

- [Configure n8n nodes](./n8n-configuration.md)
- [SuperGrok on a VPS](./vps-supergrok.md)
- [AI Assistant companion](./ai-assistant.md)
- [Manual installation](./manual-install.md)
- [Troubleshooting](./troubleshooting.md)

## GPT Image 2.5 in n8n

A new OpenAI OAuth bridge includes `gpt-image-2.5-flare` and
`gpt-image-2.5-sunburst` in model discovery. For an existing managed bridge,
use its reviewed browser runtime-update action to install the current adapter;
upgrading only the Relmio dashboard does not update an already running bridge.
The local update preserves its saved sign-in. A VPS update follows its separate
reviewed sign-in upload flow. Both paths leave n8n unchanged.

The completion screen shows image IDs from the verified model response. In
n8n's OpenAI node, select **Image**, then **Generate an Image** or **Edit Image**,
and pick the exact model from the list. Use **By ID** when needed by your n8n
version. Existing `gpt-image-2` remains available. Do not use the generic
`gpt-image-2.5` as a model ID or select an image model for a text-chat recipe.

Both variants passed bounded generation and editing tests. Exact output
size and all options remain unverified; begin with low quality. Discovery is
not a promise of account entitlement. Live, Realtime and audio are separate
capabilities and remain unsupported through this bridge.
