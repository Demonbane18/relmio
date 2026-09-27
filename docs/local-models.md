# Private local models for n8n

Relmio can manage an Ollama model runtime beside an existing self-hosted n8n installation on the same local Docker Engine or a supported SSH-connected VPS. This is a separate, provider-free workflow: it does not use ChatGPT/Codex sign-in, an OAuth token, or a provider API key, and it does not create an OpenAI Platform API key.

> **Experimental release warning:** Relmio `0.18.0-experimental.1` adds this
> managed workflow, but it has not been live-tested for the prerelease. Offline
> checks do not prove that a selected model will load, answer a workflow, fit
> actual workload peaks, or achieve any throughput. Use the separate readiness
> check during your own setup; a passing check is limited to that model and
> machine. Stable `0.17.5` remains npm `latest` and the hosted-installer default.
> Opt in with `npx --yes --ignore-scripts relmio@experimental local`, or pin
> the exact version with `npx --yes --ignore-scripts
> relmio@0.18.0-experimental.1 local`.

The companion joins the exact existing, eligible non-internal user-defined Docker bridge selected for n8n. n8n reaches it at `http://n8n-local-model:11434/v1`; Relmio publishes no host port and does not edit, restart, recreate, or execute inside n8n. The runtime is CPU-based, configured for one selected model at a time, and has cloud features disabled. Active-family `nat-unprotected`, unknown and isolated gateway modes fail closed; default/NAT and filtered `routed` modes are permitted. This is not a full host-firewall audit or isolation from the host administrator and trusted bridge peers.

## Pick a starting model

The managed catalog is a closed list of five Qwen models. Download sizes below are decimal GB calculated from Ollama registry manifest layers, observed 2026-09-26; allow additional disk for the Ollama image, n8n, Docker data, and other services. Qwen3/Qwen3.5 use Apache-2.0 model licenses; read the linked model card/license before use.

| Typical capacity tier | Catalog choice | Quantization | Download | Planning memory / context | Starting use |
|---|---|---|---:|---|---|
| Hostinger KVM 1: 1 vCPU / 4 GB | `qwen3:0.6b` | Q4_K_M | 0.523 GB | about 2 GiB; 2,048 tokens | Experiment, short classification or narrow extraction; quality and latency are limited. |
| Hostinger KVM 2: 2 vCPU / 8 GB | `qwen3.5:2b` | Q8_0 | 2.741 GB | about 5 GiB; 4,096 tokens | Light chat, classification, short extraction; use `qwen3:1.7b` if measured headroom is tight. |
| Hostinger KVM 4: 4 vCPU / 16 GB | `qwen3.5:4b` | Q4_K_M | 3.390 GB | about 7 GiB; 4,096 tokens | More capable low-volume chat and extraction. |
| Hostinger KVM 8: 8 vCPU / 32 GB | `qwen3.5:9b` | Q4_K_M | 6.594 GB | about 11 GiB; 8,192 tokens | Better quality and bounded multi-step workflows; still CPU inference. |
| Computer with 8 GB physical RAM | `qwen3:1.7b` | Q4_K_M | 1.359 GB | about 3.5 GiB; 2,048 tokens | Use only if Docker and n8n leave enough measured headroom; otherwise choose 0.6B. |
| Computer with 16 GB physical RAM | `qwen3.5:4b` | Q4_K_M | 3.390 GB | about 7 GiB; 4,096 tokens | Personal chat and extraction if Docker's allocated memory is sufficient. |
| Computer with 32 GB+ physical RAM | `qwen3.5:9b` | Q4_K_M | 6.594 GB | about 11 GiB; 8,192 tokens | Larger starting choice; verify memory and latency on the actual machine. |

“Planning memory” is the model-resource allowance used by the catalog, not measured peak RSS, a minimum, or a guarantee. Context length, runtime overhead, prompt size, Docker memory allocation, n8n, the host OS, and other workloads affect actual use. Relmio inspects Docker-visible memory, CPU, and available backing-filesystem space before showing the reviewed plan; tier marketing and physical host RAM are not substitutes for the engine's measured capacity. Neither a model tag nor a quantization label guarantees a particular token rate. There is no guaranteed tokens/second figure; benchmark your own workload.

The Qwen model names, quantization and sizes are point-in-time registry observations, not permanent upstream promises. Sources: [Qwen3 Ollama registry manifest](https://registry.ollama.ai/v2/library/qwen3/manifests/0.6b), [Qwen3.5 Ollama registry manifest](https://registry.ollama.ai/v2/library/qwen3.5/manifests/2b), [Qwen3 0.6B model card](https://huggingface.co/Qwen/Qwen3-0.6B), [Qwen3 1.7B model card](https://huggingface.co/Qwen/Qwen3-1.7B), [Qwen3.5 2B model card](https://huggingface.co/Qwen/Qwen3.5-2B), [Qwen3.5 4B model card](https://huggingface.co/Qwen/Qwen3.5-4B), [Qwen3.5 9B model card](https://huggingface.co/Qwen/Qwen3.5-9B). Retrieved 2026-09-26.

## Install beside local n8n

1. On a first-run machine, open the local dashboard with `npx --yes --ignore-scripts relmio@latest local` (or use `relmio local` from an installed command). This initializes dashboard state as needed; no pre-existing `.relmio` directory or n8n stack is required to open the route. The local-model installation itself requires an existing running n8n container and eligible Docker network. It does not create n8n, so if you have no local n8n yet, complete a separate n8n setup first. Then select **Add connection** and **Local model for n8n**.
2. Relmio inspects the local Docker engine, running n8n containers, their shared user-defined Docker networks, the engine's measured memory and CPU allocation, and available Docker backing-filesystem disk. Select the running n8n container, its existing network, and an allowlisted model.
3. Review the exact model, context and memory budget, measured engine capacity, available disk, image/model downloads, files and private network. Confirm only if the selected Docker engine and network are trusted and the reviewed budget leaves enough headroom.

4. Relmio writes its owner-only files under `~/.relmio/local/n8n-local-model`, pulls the pinned Ollama `0.34.4` runtime, starts the private runtime, and starts a separate bounded acquisition helper for the selected model. Downloading can continue after the first browser response; use model status to inspect the current state.
5. Wait until status says the model is ready after a bounded inference check. A running runtime alone is not model readiness. Then configure the n8n workflow Chat Model as below.

The reviewed plan reserves the larger of 1.5 GiB or 20% of measured Docker
memory for OS/n8n headroom, plus 256 MiB for acquisition. It requires estimated
free disk of twice the model download plus 12 GiB for runtime and download
headroom. Those are installer admission checks, not guarantees that a busy
machine will have that much real-time free memory or acceptable latency.

On macOS with ordinary Docker Desktop, this design runs a Linux arm64 CPU
container; it does not pass Apple's Metal GPU into Ollama. Physical RAM and
native macOS Ollama benchmarks do not describe the memory or speed available
to the Docker VM. Keep Docker Desktop's VM allocation and concurrent host apps
in the capacity calculation.

A fresh computer needs Docker running and an existing n8n container with an eligible shared network. Relmio does not install n8n as part of this model route. If the Docker engine is unavailable, start Docker and try again; no model files are required before first use.

## Install beside VPS n8n

1. Open **Local model · your VPS** and select from 15 Linux VM provider presets
or another supported Linux VM. This supplies source-linked login guidance, not
provisioning or permissions. Render service SSH is unsupported by the managed
installer; use the separate [manual private-service guide](hosting-compatibility.md#render-manual-private-model-service).
2. Enter the host, port and actual **SSH username**. Under **SSH authentication**, choose **Local SSH agent** or an already-approved **Password** login. Load/unlock keys locally before launching Relmio; no private-key upload, browser passphrase entry, agent forwarding or automatic password fallback is offered. Image-qualified username hints and persistent-dashboard environment details are in [Hosting compatibility](hosting-compatibility.md#ssh-agent-and-administrative-access).
3. Choose **Administrative context** deliberately: **Root account (UID 0)** for existing verified direct-root access, or **Passwordless sudo -n (model only)** for an approved non-root account. `sudo -n` must work without a prompt in the exact root context used for Docker and protected files. It never asks for a sudo password or changes sudoers. This mode cannot manage OAuth bridges, AI Assistant or SuperGrok.
4. Check the server identity and independently compare the displayed host-key fingerprint before confirming and authenticating. Review the connected account, authentication and privilege. Changing those requires a new connection and a new plan, not silently reusing an old review.
5. Select the running official n8n container, exact existing Docker network, and allowlisted model. Relmio reads Docker total allocated memory (`docker info` `MemTotal`), CPUs and available disk. Separately, `/proc/meminfo` `MemAvailable` must cover the model allowance plus 256 MiB for the helper and 256 MiB transient headroom, rechecked before apply/retry. Docker `MemTotal` is not free RAM or measured peak usage. Review the complete resource/download plan and explicitly confirm remote changes.
6. The administrator's root-owned, non-symlink **`/docker` must already exist**,
   without group/other write permission. On first approved use, Relmio may
   create `/docker/n8n-openai-oauth` and its `.managed-by-relmio-root` marker;
   it preserves existing managed-parent permissions and checks identity. Model
   files live in `/docker/n8n-openai-oauth/local-model`. Its
   `.managed-by-relmio.json` ownership marker must be a root-owned mode-`0600`
   regular file with exactly one hard link. Relmio rechecks the marker and its
   staged `.next` file before and after upload, verifies expected content and
   parent identity, and only then promotes the marker. Runtime assets are also
   verified against recorded hashes and root-owned mode `0600`.
7. The sibling `.local-model-operation.lock` coordinates operations; an
   existing or uncertain lock requires administrator inspection, never blind
   unlock/retry. After final confirmation, build-capable actions may create
   root-only mode-`0700` Buildx state inside that lock, not in the user's Docker
   configuration. Cached retries needing no build, status, and removal do not
   create it. Verified failure cleanup removes only owned state and the lock;
   it never clears the model cache.
8. If an SSH command or SFTP upload has started but completion cannot be
   confirmed, the remote outcome is unknown. An interrupted upload may leave a
   partial managed file; Relmio retains the lock and any Buildx state for
   administrator inspection, even if a later SSH connection responds. Do not
   assume nothing happened or retry blindly. A verified nonzero exit is a
   known failure and follows normal cleanup. Registry credentials are not
   copied, moved, or printed.
9. The runtime joins the selected network without a published host port. A
   bounded acquisition helper downloads and verifies the selected model;
   outbound image/model-registry access is required. Refresh status until
   inference readiness succeeds, configure n8n below, and disconnect when
   finished.

The VPS path requires **rootful Docker Engine, Docker Compose v2 and its Buildx
build tooling in the selected administrative context**. The existing Docker
context must already be `default`, pointing at `unix:///var/run/docker.sock`,
with unambiguous built-in default builder selection and no
`instances/default` shadow. Model setup reads only bounded
`$HOME/.docker/buildx/current` and `defaults` selectors; a changed/mismatched
`HOME`/Docker-config location or a saved custom/ambiguous builder is rejected.
On Windows, selector paths receive read-only ACL checks: inherited access for
the current user, SYSTEM, and Administrators is allowed; untrusted owners or
write-capable untrusted ACEs fail closed, and Relmio does not change ACLs.
The workflow does not alter saved Docker config, run `docker buildx inspect`,
or read `config.json`/nodegroup TLS secrets. Conflicting inherited
`BUILDX_BUILDER`/`BUILDX_CONFIG` and Docker/Compose selection overrides are
rejected. Review/preflight and build/retry each attest the built-in builder.
Explicit image-build calls pass `--builder default`; Compose `run` calls that
can trigger an implicit build use the same attested command-scoped config and
`BUILDX_BUILDER=default` environment, without unsupported Compose flags. No
pre-existing running builder is required. Podman-backed `docker`, rootless,
remote or custom contexts, and user-only plugins unavailable under sudo do not
satisfy this contract. See [the exact hosting prerequisites](hosting-compatibility.md#current-path-and-host-requirements).

Noninteractive sudo and Docker-daemon access are root-equivalent powers, not an OS least-privilege sandbox. Model uploads contain runtime assets and non-secret deployment metadata only; remote administrators may still record command I/O. Credential-bearing VPS routes require a separate already-approved direct-root session. This hosting change is not an OpenAI scope grant or model/TTS entitlement.

## Configure an n8n workflow model

Create an **OpenAI-compatible** model credential/provider in n8n and enter the values shown by the completed Relmio flow:

```text
Base URL: http://n8n-local-model:11434/v1
API key: local-only
Model: the exact selected model ID, such as qwen3:0.6b
Use Responses API: Off
```

The API-key field is required by some n8n dialogs, but Ollama ignores its value. `local-only` is a placeholder, not a password or authentication boundary. Use the exact selected ID. The managed model API has no published host port and is reachable through the selected eligible network; its peers and Docker host administrator remain trusted. The documented recipe uses Chat Completions with Responses API disabled. This is a recipe setting, not a claim that Ollama lacks a Responses endpoint. For manual Render setup, substitute the actual Render internal hostname from its service dashboard rather than the managed Docker alias.

Qwen thinking output can consume a small output-token allowance before any visible answer appears. In the native Ollama 0.34.4 smoke with `qwen3:0.6b`, a 32-token Chat Completions request returned an empty visible answer; explicitly setting `reasoning_effort: "none"` produced a visible answer. The native API's `think: false` also passed the acquisition probe. Use those controls only where your client exposes them, or allow enough output tokens and inspect the actual response. Relmio does not configure these options inside n8n, and a `/no_think` prompt alone did not resolve that smoke case.

A workflow's **Chat Model** connection is separate from n8n's **AI Assistant** sandbox and tool capability. A model being ready does not install or enable the Assistant sandbox. A model's ability to emit tool-call syntax is not proof it chooses correct tools, arguments, or follow-up calls in your n8n version. Start with a simple prompt, then test each workflow and any tool action under human review. For Assistant sandbox setup, resource needs, and the production recommendation, see [n8n AI Assistant companion](ai-assistant.md).

## Network, authentication, and privacy boundaries

- Ollama's local HTTP API has no authentication by default. A required n8n API-key value is ignored. Any container on the selected Docker network can potentially reach chat **and model-management** operations; only choose a network whose other containers you trust.
- The service has no host port, public route, or Docker socket mount. The listener is private to the selected network, not cryptographically authenticated against peers on that network or the Docker host administrator.
- Relmio disables Ollama cloud features and does not sign into an Ollama account. This does **not** disable outbound internet used to pull the pinned container image or selected model weights. The first install and model download need registry access; this is not an offline installer.
- Once local weights are used with cloud features disabled, inference requests go to the local runtime rather than a hosted model provider. n8n tools may still contact external services, and prompts/results can be retained by n8n execution history, host logs, or backups. Image/model registries can observe download traffic.
- Model output is untrusted input. Preserve n8n's own credentials, permissions, and human approval boundaries for tools and actions.

## Download recovery, cache, and removal

The selected model cache is stored in a Relmio-owned Docker volume. A failed or interrupted pull may leave partial blobs that continue to use disk after restart/retry; Relmio preserves the cache, but that does not guarantee that every interrupted transfer will resume from its previous byte. The catalog pins the full reviewed registry-manifest SHA-256 digest and quantization for each model. Acquisition verifies both before inference and model-ready status, including on first install; if an upstream mutable tag points to different content, it fails closed rather than accepting or automatically substituting that content. Status does not label the model ready until the acquisition completes and inference succeeds. From the local dashboard, choose **Review model retry**; on the dedicated VPS model page, choose **Review retry**. Both are reviewed actions for the same selected model, retain its cache, and do not silently switch model or quantization.

A full removal deletes the owned runtime, helper, managed files, and model cache. Relmio requires a separate review and explicit confirmation that cached model data will be deleted. Do not treat ordinary dashboard refresh, package upgrade, or failed download as permission to clear model weights. Removal does not stop or modify n8n or unrelated Docker resources.

## Maintainer acceptance evidence

The repository includes a separate [Linux local-model acceptance harness](maintenance.md#linux-local-model-acceptance-harness) for a disposable n8n fixture, cold model acquisition, fresh-process reconnect, an actual n8n workflow, one model-only fault, cache-preserving retry and explicitly approved removal. A second fresh-checkout scenario interrupts a genuinely partial cold download and checks partial-cache retention before recovery; it does not claim network byte-offset resume. Neither scenario targets your existing n8n. CLI/guard smoke checks are not live Linux/Docker/provider evidence; a human-approved Linux host and real workflow runs are still required. Do not use automatic Compose teardown or cache deletion as a troubleshooting step.

## Sources and limits

Runtime behavior and model metadata change. The catalog's download sizes, quantizations and license links were read from the official [Ollama registry manifests](https://registry.ollama.ai/) and linked Qwen model cards on 2026-09-26. Ollama documents its [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [authentication](https://docs.ollama.com/api/authentication), [Docker deployment](https://docs.ollama.com/docker), [cloud controls](https://docs.ollama.com/faq), and [pull API](https://docs.ollama.com/api/pull). These sources establish API/configuration facts, not performance measurements or a guarantee that a particular model is suitable for every n8n workflow.

## Manually generated platform model plans

The authenticated **Hosting options** catalog also generates review artifacts
for private operator-managed model services; these are not this managed local
or VPS installation and do not inherit its digest-attested acquisition.
Supported model artifacts cover Render, Railway, Fly.io, ECS on EC2/Fargate,
EKS, EKS Fargate, GKE Standard/Autopilot, AKS, Cloud Run, Azure Container Apps
and Azure Container Instances. Render, Railway and Fly use operator-created
private services/Machines and persistent storage. Scheduler profiles require
existing private routing and storage; EKS Fargate specifically needs an
existing static EFS PV/PVC and does not enforce Kubernetes NetworkPolicy.
Cloud Run requires an exact prepopulated read-only Ollama cache bucket plus
IAM/OIDC-aware caller steps; it does not pull weights into a writable service
cache. Azure profiles require existing Azure Files resources; ACI takes its
storage key only through secure deployment input.

These profiles pin the runtime image, but the operator pulls the selected
mutable model tag through the private backend `/api/pull` route and must then
verify real Chat Completions inference. Download completion, container health
or a generated connection URL is not readiness. Cloud Run, managed containers
and scheduler workloads are operator-applied artifacts, not provider-live
support. The planner reads only supplied nonsecret values and accepts no model
API key or provider credential; it exposes no model endpoint or applies files.
See [Hosting compatibility](hosting-compatibility.md#hosting-catalog-and-plan-artifacts)
for all platform paths, input boundaries, private-network constraints and
source links.

Related guides: [Local endpoints](local-endpoints.md), [Local dashboard](local-dashboard.md), [VPS and n8n](vps-and-n8n.md), [Configure n8n nodes](n8n-configuration.md), and [Hosting compatibility](hosting-compatibility.md).
