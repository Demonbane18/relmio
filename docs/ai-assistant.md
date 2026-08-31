# n8n AI Assistant companion

Relmio can install n8n's self-hosted AI Assistant sandbox and optional SearXNG
web search through local Docker discovery or an SSH host. Neither route reads a
ChatGPT/Codex sign-in or uses the OAuth sidecar.

> **Preview:** AI Assistant is Preview. Review every generated workflow before
> activating it, and use n8n's recommended Daytona sandbox for production.

## What the wizard changes

For n8n on the same computer, start the standard local wizard and choose
**n8n AI Assistant tools**. Direct local Docker-socket discovery works on
macOS, Linux, and Linux under WSL2. Relmio records the selected n8n container,
network, and SearXNG choice, then creates only
`~/.relmio/local/n8n-ai-assistant` after you confirm.

For an SSH-reachable host, run `relmio assistant`. After SSH host-key
confirmation, read-only n8n discovery, a selected existing Docker network, and
final confirmation exactly set to true, Relmio may first create
`/docker/n8n-openai-oauth` and write its shared mode-0600 Relmio root marker. It
then creates only the `assistant-sandbox` child there. The SSH path does not write existing n8n project files.
Both paths use an independent Compose project
identity recorded in a strict, mode-0600 Assistant marker and keep n8n
configuration operator-owned.

The required companion has three services:

- `relmio-sandbox-certs` bootstraps mTLS certificates once.
- `relmio-sandbox-api` provides the n8n Sandbox Service API.
- `relmio-sandbox-runner-1` is a privileged Docker-in-Docker runner on its own
  unpublished Compose network. Treat it as equivalent to root on the host. It
  needs egress to pull n8n's sandbox image on first use.
- `relmio-searxng` provides optional JSON web search only when you opt in during
  the reviewed plan. Web search is **off by default**; Relmio never adds it
  silently.

Compose assigns the companion's containers short deterministic names derived
from the first 16 hexadecimal characters of its recorded installation ID, such
as `relmio-ai-<generated-id>-api`. The full 128-bit ID remains in ownership
labels and the managed marker. Existing markers remain valid without migration;
a later separately confirmed companion update may recreate only its own
containers to adopt these names. It never renames, recreates, restarts, stops,
or executes inside n8n.

The sandbox API joins the selected existing n8n Docker network. When enabled,
SearXNG joins it with a separately generated collision-resistant,
Docker-internal alias. The selection and aliases are stored in the strict,
versioned managed assistant marker and reused for updates. The result view
always shows the sandbox URL and shows this additional stable URL only when web
search is enabled:

```text
http://relmio-ai-sandbox-<generated-id>:8080
http://relmio-ai-searxng-<generated-id>:8080  (when enabled)
```

There are no `ports:` mappings, reverse-proxy routes, or changes to the
existing n8n Compose file, image, container, or workflows. Relmio never stops,
restarts, recreates, rebuilds, or executes inside n8n.

## Prerequisites Relmio will not change

The SSH-host workflow read-only inspects the selected n8n container and
returns only an allowlisted prerequisite status: whether its
`N8N_ENABLED_MODULES` setting is missing, configured without `instance-ai`, or
enabled with `instance-ai`. It never returns the container environment or the
raw setting value. The wizard refuses installation unless `instance-ai` is
enabled.

Apply the prerequisite through the existing n8n deployment workflow. When the
variable is missing, use this exact form in the existing n8n service:

```text
N8N_ENABLED_MODULES=instance-ai
```

When the variable already contains module entries but lacks `instance-ai`, append
`instance-ai` as a distinct comma-delimited token while preserving existing
module entries. Do not replace unknown existing values. For example:

```text
# Existing service configuration
N8N_ENABLED_MODULES=module-a,module-b

# Preserve existing entries and append the required token
N8N_ENABLED_MODULES=module-a,module-b,instance-ai
```

Use your existing n8n deployment workflow; Relmio does not claim a
provider-specific UI path. Apply the change to the existing n8n service, then
redeploy or restart n8n, verify that n8n is healthy, reconnect to Relmio, and
run discovery again before reviewing a new plan.

The direct local wizard instead returns the complete required environment block
after it verifies the companion stack. You apply that block through your own
n8n deployment workflow. Relmio will not edit the existing n8n Compose file,
image, or environment;
restart or recreate n8n; or exec into n8n to make this prerequisite change.
It reports only the allowlisted status, never the raw environment value. Plan
for at least **4 GB RAM** and **2 vCPU** for the n8n and companion workload;
capacity needs can be higher for real workflows.

## Enter the result values in n8n

Relmio generates four separate local 256-bit secrets: the sandbox API key,
runner registration token, runner API key, and SearXNG secret. It uploads the
secrets only in the managed mode-0600 `.env` file on the SSH path and writes
them only to that same owned file on the direct local path. The registration, runner,
and SearXNG secrets are never returned or logged. The sandbox API key is shown
once in the local result view. Even with web search disabled, the private
SearXNG secret remains in that `.env`: this lets a later reviewed opt-in start
only the new SearXNG service without overwriting the running sandbox/runner
credentials. No SearXNG service, settings file, alias probe, URL, or host port
is created while it is disabled.

In n8n's AI Assistant settings, enter:

| Dialog | Value |
| --- | --- |
| Sandbox Service URL | The stable generated result URL |
| Sandbox API key | The one-time result value |
| SearXNG Instance URL | The stable generated result URL, only when web search was enabled |

URLs are stable generated result values; only the sandbox API key is
one-time-displayed. SearXNG has no user-facing key. When enabled, its generated
settings explicitly enable the JSON response format n8n needs.

The `includeSearxng` choice is an exact boolean in the reviewed plan and final
confirmation request; missing, string, or otherwise ambiguous values are
rejected. A managed disabled installation can later enable SearXNG only after
Relmio re-attests the existing sandbox resources and the missing SearXNG
resource name, then starts only SearXNG. Disabling an already managed SearXNG
service would stop or remove it, so Relmio rejects that change and requires a
separately authorized cleanup path instead.

## Immutable companion image pins

Every generated production image reference is the reviewed full
`tag@sha256:<OCI-index-digest>` value. The API/certificate service, privileged
runner, and nested sandbox are reviewed as one compatible n8n Sandbox Service
unit; optional SearXNG is pinned independently. Generated Compose never uses
`latest`, `stable`, a tag-only reference, a digest-only reference, environment
interpolation, or user input for these images.

The upstream review sources are the [n8n Sandbox Service repository](https://github.com/n8n-io/n8n-sandbox-service), its [API](https://github.com/n8n-io/n8n-sandbox-service/pkgs/container/n8n-sandbox-service-api), [runner](https://github.com/n8n-io/n8n-sandbox-service/pkgs/container/n8n-sandbox-service-runner-dind), and [nested sandbox](https://github.com/n8n-io/n8n-sandbox-service/pkgs/container/n8n-sandbox-service-sandbox) GHCR package pages; and the [SearXNG repository](https://github.com/searxng/searxng) and [GHCR package page](https://github.com/searxng/searxng/pkgs/container/searxng). The n8n setup documentation remains authoritative for product configuration.

For a managed companion, an image change is never automatic: update Relmio
locally, reconnect for host-key confirmation and read-only discovery, review the
exact companion-only plan, preserve the recorded SearXNG choice unless you
deliberately change it, and provide final confirmation. Then verify that only
managed companion resources changed, no host ports were published, and n8n is
healthy. Roll back only with the full previously reviewed immutable pin set
through that same separately confirmed managed update; never pull a moving tag
or mutate n8n directly. The maintainer procedure is in
[maintenance.md](maintenance.md#updating-or-rolling-back-ai-assistant-companion-images).

## Model routes

### Direct OpenAI provider

Choose **OpenAI** in n8n and keep the current supported model selection. If your
n8n instance continues to accept this selection, preserve it:

```text
openai/gpt-5.6-sol
```

Enter your own OpenAI Platform API key directly in n8n. Relmio does not request,
read, transmit, retain, or configure this model credential.

An example model shown in n8n documentation is not a migration requirement.
Change models only if n8n rejects the current selection or you deliberately
choose another supported model.

ChatGPT/Codex subscription sign-in is not an OpenAI Platform API key. Relmio
does not offer it as a compliant model provider for AI Assistant.

### Optional: custom OpenAI-compatible endpoint

n8n's custom/self-hosted OpenAI-compatible dialog defaults to an Ollama-style
route with **Base URL**, **API key**, and **Model ID** fields. Use it only if you
already run a separate, n8n-reachable Relmio OpenAI-compatible endpoint backed
by a user-owned OpenAI Platform API key.

- **Base URL:** that endpoint's `/v1` address.
- **API key:** that endpoint's private Relmio client credential. It is not an
  OpenAI-issued API key.
- **Model ID:** a model ID exposed by the Platform-key-backed endpoint.

The assistant wizard does not deploy a new remote Platform gateway. Relmio's
existing ChatGPT/Codex OAuth sidecar may be technically compatible, but is
experimental/private/policy-uncertain. It is not auto-selected, enabled, or
described as policy-approved for this configuration.

## Platform account guardrails

No setup can guarantee an account is never flagged. For the direct OpenAI
provider route, use a dedicated OpenAI Platform project/key, keep the key in
n8n's server-side credential storage, and set project rate/spend limits and
alerts. Enable usage monitoring, grant least user access, plan rotation/revocation,
require human review for generated workflows, and keep the provider path free of
public exposure.

Relmio cannot inject per-user safety identifiers or moderation into n8n's
direct provider path. Configure any controls available in your Platform project
and n8n instance; this companion cannot make claims about provider enforcement.

## Verification and failure behavior

Before start, the companion Compose configuration is validated. After start,
Relmio verifies sandbox API health, the expected running services for the
selected web-search option, and
the absence of every host-published port. Immediately before any companion
write, it reruns the selected container's read-only network and prerequisite
discovery. The selected network must still exist and the allowlisted
`instance-ai` status must still be enabled and match the reviewed plan; a
changed result consumes that plan without installing.

For a new companion or a normal managed update, a post-start safety failure
stops and removes only the companion project. When adding SearXNG to an
existing managed sandbox, post-start cleanup removes only the optional SearXNG
service: the existing sandbox remains and must not be used until an
administrator verifies its state. If cleanup cannot be confirmed, treat the
installation as unsafe and do not use the companion until an administrator
verifies the relevant managed state.

The bounded command allowlist refuses an unmanaged assistant directory, symlinked
assistant paths, and a symlinked or non-directory `/docker/n8n-openai-oauth`
parent. It accepts Docker names only after validation. Before any update, start,
or cleanup, Relmio attests that matching project containers, networks, and
volumes carry the recorded install identity; it never cleans up an unattested
project. It also checks every predictable generated companion container name,
the explicit internal network, and the TLS volume regardless of Compose project
labels: a new install refuses any match, while an update requires the recorded
identity labels on every match.

## Reference

- [n8n: Set up AI Assistant](https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-ai-assistant)
- [n8n: Docker Compose installation](https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose)
