// Error help for the setup guide. Facts come from docs/troubleshooting.md, docs/vps-and-n8n.md,
// docs/hosting-compatibility.md, docs/maintenance.md, docs/local-models.md and
// docs/local-n8n-stack.md. The engine checks boolean flags, then
// codes[code | errorCode | stoppedReason], then recovery, then status, then fallback.
// Each code gets one entry: a title, one sentence and at most three steps.

const onServerPages = (selector) => Object.fromEntries(
  ["vps", "assistant", "supergrok-vps", "claude-vps", "local-model-vps"].map((page) => [page, selector]));
const MODEL_RETRY = { local: "#local-model-review-retry", "local-model-vps": "#review-retry" };
const FINGERPRINT = {
  vps: "#fingerprint-button",
  assistant: "#fingerprint-button",
  "supergrok-vps": "#scan-button",
  "claude-vps": "#scan-button",
  "local-model-vps": "#scan",
};
const USAGE = { vps: "#global-error-recovery", local: "#global-error-recovery" };
const SIGN_IN = onServerPages("#username");
const NETWORK = { ...onServerPages("#network"), vps: "#network-select", assistant: "#network-select" };

// Which setups need root, and the rule about the server's SSH policy.
const ROOT_ONLY = "The ChatGPT, Assistant, SuperGrok and Claude setups need a direct root sign-in. Only the Local model setup also accepts another account, with passwordless sudo -n.";
const SSH_RULES = "Leave the server's SSH rules as they are. Relmio never asks anyone to turn on root or password sign-in.";
const AGAIN = "Then try this step again.";
const PAGE_MESSAGE = "Then follow the message on the page. It names the next action for this setup.";

const usageLimit = {
  title: "Usage limit reached",
  say: "OpenAI refused the request because a usage limit was reached. It can be your plan's limit or the weekly limit set for this app in ChatGPT. Relmio does not switch accounts or billing.",
  steps: [
    "Press Manage usage to see which limit applies and when it resets.",
    "Wait for that reset, or raise this app's limit in ChatGPT if you set it lower.",
    "Try again with the same account. Signing in again does not restore usage.",
  ],
  targets: USAGE,
};

const signInBlocked = {
  title: "Sign-in cannot restart yet",
  say: "Relmio could not confirm that the last ChatGPT sign-in stopped safely. It blocks a new attempt until it can.",
  steps: [
    "Close the sign-in helper or tab the message names.",
    "If the message says so, restart Relmio.",
    "Then start one fresh sign-in.",
  ],
};

const modelRetry = (title, say) => ({
  title,
  say,
  steps: [
    "Press Review retry. Retry keeps the files already downloaded.",
    "Do not delete the model cache as a retry step.",
    "If it keeps failing, keep the error text and report it.",
  ],
  targets: MODEL_RETRY,
});

const modelIdentity = (title) => ({
  title,
  say: "The model no longer matches the version Relmio reviewed, so it was rejected before use.",
  steps: [
    "Do not pull a different tag or skip the check.",
    "Wait for a newer Relmio release with an updated model list.",
  ],
});

export const GUIDE_ERRORS = {
  recovery: {
    none: {
      title: "This step stopped",
      say: "Relmio stopped this step to keep your setup safe. The message explains what happened.",
      steps: [
        "Read the error message on the page.",
        "Fix what it names, then try the step again.",
        "If it repeats, open Troubleshooting in the Relmio docs.",
      ],
    },
    "retry-later": {
      title: "Try again a bit later",
      say: "The service was busy or did not finish. Relmio keeps the same account and does not switch billing.",
      steps: [
        "Wait a few minutes.",
        "Try the same step again with the same account.",
        "Do not switch accounts or delete anything to get around it.",
      ],
    },
    reauthorize: {
      title: "Check the ChatGPT sign-in",
      say: "OpenAI did not accept this account's sign-in or plan permission. Check that the selected account is the one you meant to use.",
      steps: [
        "If Sign in again is shown, press it and use the same account.",
        "Finish the sign-in on the ChatGPT page.",
        "Come back and repeat the step that stopped.",
      ],
      targets: { vps: "[data-siwc=return]", local: "[data-siwc=return]" },
    },
    "enable-plan": {
      title: "Allow ChatGPT plan use",
      say: "You are signed in, but this account has not allowed plan use. Signing in and allowing plan use are separate steps.",
      steps: [
        "Press Allow ChatGPT plan use.",
        "Approve it on the ChatGPT page.",
        "Read the plan notice and press Got it.",
      ],
      targets: { vps: "[data-siwc=grant]", local: "[data-siwc=grant]" },
    },
    "manage-usage": usageLimit,
    "fix-request": {
      title: "Fix the request",
      say: "Something in the request was not accepted. If a box is marked, that is the one to fix.",
      steps: [
        "Check the marked box or the setting the message names.",
        "Correct it, then try again.",
        "For n8n requests, compare your node with Configure n8n nodes in the docs.",
      ],
    },
    "fix-configuration": {
      title: "Sign-in setup needs a fix",
      say: "OpenAI did not accept this sign-in setup or request. The message names the reason.",
      steps: [
        "Follow the repair the message names.",
        "Sign in again only if the message asks for it.",
      ],
    },
    "review-again": {
      title: "Review the setup plan again",
      say: "Something changed since you reviewed the setup plan, so Relmio stopped and needs a fresh review.",
      steps: [
        "Check the server, account and n8n choices again.",
        "Press Review again.",
        "Approve the new setup plan.",
      ],
      targets: { vps: "#review-button", local: "#review-button" },
    },
    "resolve-handoff": {
      title: "Check the transfer first",
      say: "A handoff of your ChatGPT session may have started. Relmio keeps it frozen so two installs never use it at once.",
      steps: [
        "Do not start another sign-in or install yet.",
        "Open Recover a transfer or staged installation.",
        "Review the pending transfer, then confirm within five minutes.",
      ],
      targets: { vps: "#vps-siwc-recovery", local: "#local-siwc-recovery" },
    },
  },
  codes: {
    retryBlocked: signInBlocked,
    oauthRetryBlocked: signInBlocked,
    remoteOutcomeUnknown: {
      title: "Result unknown",
      say: "A server command ran out of time or lost its connection, so Relmio cannot tell whether it finished. It does not retry on its own.",
      steps: [
        "Do not repeat the step yet.",
        "Check the server first, or ask its administrator.",
        "Do not delete Relmio lock or temporary files by hand.",
      ],
    },
    managedPartialStack: {
      title: "Remove the partial stack",
      say: "Startup did not finish, and part of the new n8n stack is left. Relmio needs to remove it before a fresh try.",
      steps: [
        "Export any n8n data you need.",
        "Tick the removal box.",
        "Press Remove owned stack, then start a new setup.",
      ],
      targets: { local: "#remove-n8n-stack-confirm" },
    },
    retryableNgrokSetup: {
      title: "Check ngrok and try again",
      say: "ngrok rejected the setup, often because the hostname is not reserved or the token is not active. Relmio cleared the three secret boxes for safety.",
      steps: [
        "Check the hostname on the ngrok Domains page.",
        "Copy one active token from Your Authtoken.",
        "Enter the token and the Basic Auth pair again, then install.",
      ],
      targets: { local: "#ngrok-authtoken" },
    },
    retryablePlan: {
      title: "Enter the secrets again",
      say: "The install stopped and Relmio cleared the ngrok and Basic Auth boxes for safety. Your reviewed setup plan is kept.",
      steps: [
        "Fix the problem the message names.",
        "Enter all three secrets again.",
        "Press Install on this computer.",
      ],
      targets: { local: "#ngrok-authtoken" },
    },
    ssh_identity_review_required: {
      title: "Check the server again",
      say: "The server identity check was already used or no longer matches. Relmio needs a fresh check before it connects.",
      steps: [
        "Press Check this server again.",
        "Compare the new fingerprint with your trusted copy.",
        "Tick the box, then connect.",
      ],
      targets: FINGERPRINT,
    },
    ssh_root_login_disabled: {
      title: "This server turns off root sign-in",
      say: "The server refused root and named another account to sign in with.",
      steps: [
        "For a local model, use the Local model setup: type that account as the sign-in name and choose Passwordless sudo -n.",
        ROOT_ONLY,
        SSH_RULES,
      ],
      targets: SIGN_IN,
    },
    ssh_not_root: {
      title: "This account is not root",
      say: "The sign-in worked, but this account is not root, the server's main administrator account.",
      steps: [
        "If this server already lets you sign in as root, type root as the sign-in name and connect again.",
        ROOT_ONLY,
        SSH_RULES,
      ],
      targets: { ...SIGN_IN, "local-model-vps": "#ssh-privilege" },
    },
    ssh_auth_refused: {
      title: "The server refused this sign-in",
      say: "The server did not accept this sign-in name with the password or SSH key that was offered.",
      steps: [
        "Check the sign-in name and the password. For a key, load it with ssh-add before you start Relmio, then choose Local SSH agent.",
        ROOT_ONLY,
        SSH_RULES,
      ],
      targets: SIGN_IN,
    },
    vps_prereq_linux: {
      title: "Not a Linux server",
      say: "Relmio manages Docker on a Linux server, and this sign-in reached another kind of system, such as a single service container.",
      steps: [
        "Use the address of the Linux server that runs Docker and n8n.",
        "For other kinds of hosting, open Hosting options to see what Relmio can prepare.",
      ],
      targets: onServerPages("#host"),
    },
    vps_prereq_uid: {
      title: "No administrator rights on the server",
      say: "The server check did not run as root, which Relmio needs to manage Docker there.",
      steps: [
        "With Passwordless sudo -n, check on the server that sudo -n true works for this account without asking for a password.",
        ROOT_ONLY,
        "Relmio never asks for a sudo password and never edits sudoers.",
      ],
      targets: { ...SIGN_IN, "local-model-vps": "#ssh-privilege" },
    },
    vps_prereq_tools: {
      title: "Standard Linux tools are missing",
      say: "Relmio checks its own files with standard GNU tools, and one of them is missing or unreadable on this server.",
      steps: [
        "On the server, check that GNU dd, stat, find, awk and sha256sum are installed and that /proc/self/mountinfo can be read.",
        "Systems built on BusyBox are not supported.",
        AGAIN,
      ],
    },
    vps_prereq_docker_dir: {
      title: "The server needs a /docker folder",
      say: "Relmio keeps its files under /docker on the server and does not create that folder itself.",
      steps: [
        "Sign in to your own server and run: sudo install -d -o root -g root -m 0755 /docker",
        "If /docker is already there, it must be a real folder owned by root that only root can write to.",
        AGAIN,
      ],
    },
    vps_prereq_docker_cli: {
      title: "Docker was not found",
      say: "Relmio found no docker command it can trust for the account that signed in.",
      steps: [
        "Install Docker Engine with its Compose plugin from Docker's own packages. Docker installed as a snap is not found.",
        "The docker program must be owned by root and writable only by root.",
        AGAIN,
      ],
    },
    vps_prereq_docker_context: {
      title: "Docker points at another engine",
      say: "Docker for this account is set to a remote, custom or rootless engine, and Relmio works only with the standard local one.",
      steps: [
        "On the server, run docker context show. Relmio needs the answer default.",
        "Review any DOCKER_HOST or DOCKER_CONTEXT setting for this account before you change it.",
        "Relmio does not switch the context for you. Try this step again once it is set.",
      ],
    },
    vps_prereq_docker_engine: {
      title: "Docker is not running",
      say: "Relmio could not reach a running Docker Engine through the server's standard socket.",
      steps: [
        "On the server, run docker info. It must answer without an error.",
        "Start Docker Engine if it is stopped.",
        AGAIN,
      ],
    },
    vps_prereq_compose: {
      title: "Docker Compose is missing",
      say: "Relmio starts its helpers with Docker Compose, and docker compose did not work on this server.",
      steps: [
        "On the server, run docker compose version. It must print a version.",
        "Install or repair the Compose plugin from Docker's own packages.",
        AGAIN,
      ],
    },
    vps_prereq_builder_config: {
      title: "Custom Docker build settings found",
      say: "This account sets a custom Docker build option, and Relmio builds only with Docker's built-in default builder.",
      steps: [
        "On the server, look in the account's environment for BUILDX_BUILDER, BUILDX_CONFIG, BUILDKIT_HOST, DOCKER_CONFIG and COMPOSE_BAKE.",
        "DOCKER_BUILDKIT may be unset, empty or 1, never 0.",
        "Review each setting before you remove it, then connect again.",
      ],
    },
    vps_prereq_default_builder: {
      title: "Docker's default builder is not selected",
      say: "Docker on this server has a saved builder choice that Relmio cannot confirm as the built-in default.",
      steps: [
        "Ask the server's administrator to review the saved Buildx builder selection for this account.",
        "Do not check it with docker buildx inspect. That command can write state and show secrets.",
        "Relmio does not switch or reset builders. Connect again once the default builder is selected.",
      ],
    },
    vps_prereq_rootless: {
      title: "Rootless Docker is not supported",
      say: "This server runs rootless Docker or Podman, and Relmio manages only the standard Docker Engine that runs as root.",
      steps: [
        "Use a server with the standard Docker Engine.",
        "Relmio does not change how Docker is installed.",
      ],
    },
    vps_prereq_probe: {
      title: "The server check did not pass",
      say: "Relmio could not confirm administrator rights and a standard Docker setup on this server.",
      steps: [
        "Check that this account is root, or for a local model that sudo -n works without asking for a password.",
        "On the server, check that docker info and docker compose version both work.",
        AGAIN,
      ],
    },
    vps_operation_lock: {
      title: "An earlier action left a lock",
      say: "Relmio holds a lock on the server while it works, and a lock from another action or an interrupted one is still there.",
      steps: [
        "If another Relmio action is running on this server, wait for it to finish.",
        "Leave the lock files alone. Deleting them can hide work that stopped halfway.",
        "Otherwise ask the server's administrator to inspect the lock under /docker/n8n-openai-oauth, as Maintenance in the Relmio docs describes.",
      ],
    },
    vps_network_unsupported: {
      title: "This Docker network cannot be used",
      say: "On the selected Docker network n8n could not find the Relmio helper by name, or the helper could not reach the internet.",
      steps: [
        "Choose another network in the list if n8n is on more than one.",
        "Otherwise attach n8n to a user-defined Docker network yourself. Relmio does not change n8n.",
        "Then check again.",
      ],
      targets: NETWORK,
    },
    vps_step_compose_config: {
      title: "Docker Compose refused the files",
      say: "Docker Compose on this server did not accept the files Relmio wrote for the helper.",
      steps: [
        "On the server, run docker compose version. An old Compose plugin is one possible cause.",
        PAGE_MESSAGE,
        "n8n was not changed.",
      ],
    },
    vps_step_build: {
      title: "The helper image did not build",
      say: "Docker could not build the helper's image on this server.",
      steps: [
        "Check that the server has free disk space and can reach the internet.",
        "If the server check warned that Buildx is missing, install Docker's Buildx plugin.",
        PAGE_MESSAGE,
      ],
    },
    vps_step_start: {
      title: "The helper did not start in time",
      say: "The helper's container did not start and report healthy in the time Relmio waits.",
      steps: [
        "A first start can be slow on a small server, so check its free memory.",
        PAGE_MESSAGE,
        "n8n was not changed.",
      ],
    },
    vps_step_image_check: {
      title: "The built image was not found",
      say: "Docker could not show the helper's image right after the build.",
      steps: [
        "Follow the message on the page. It names the next action for this setup.",
        "If it repeats, keep the error text and report it.",
      ],
    },
    vps_host_unsupported_cpu: {
      title: "This server's processor is not supported",
      say: "This setup needs a 64-bit Intel or AMD (x86_64) or ARM (aarch64) server, and this one reports another type.",
      steps: [
        "Use a server with one of those processors for this setup.",
        "Nothing was changed on this server.",
      ],
    },
    install_unconfirmed: {
      title: "Install not confirmed",
      say: "The install stopped before Relmio could confirm it, so part of it may be left on this computer.",
      steps: [
        "Read the error message on the page.",
        "Press Back to dashboard and look under Connections for a leftover connection. Manage or remove it there.",
        "Then come back and review the plan again. Your settings are kept.",
      ],
      targets: { local: "#setup-back-to-dashboard" },
    },
    subscription_sharing_usage_limit_exceeded: usageLimit,
    subscription_sharing_user_not_eligible: {
      title: "Plan use not available",
      say: "OpenAI says ChatGPT plan use is not available for this account, workspace or policy. Signing in again or retrying does not change that.",
      steps: [
        "Check that you signed in with the ChatGPT account and workspace you meant to use.",
        "If it should be eligible, contact OpenAI Support with the error shown.",
      ],
    },
    siwc_lock_unavailable: {
      title: "Account is busy",
      say: "Another Relmio action held this account's session for too long.",
      steps: ["Wait a moment, then try again.", "Do not delete lock files by hand."],
    },
    usage_limit: {
      title: "Plan usage is paused",
      say: "A usage limit was reached, or OpenAI could not check the usage or the account just then. The limit can be your plan's or this app's limit in ChatGPT. Untested models are tried again later.",
      steps: [
        "Wait, or open Manage usage in ChatGPT.",
        "Model checks resume on their own, after 60 minutes at the earliest.",
      ],
      targets: { vps: "#vps-owner-models-status" },
    },
    reauthorize: {
      title: "Sign-in needed for checks",
      say: "OpenAI rejected the ChatGPT sign-in during a model test.",
      steps: ["Press Check installed account.", "If it says the sign-in needs a fresh sign-in, press Refresh ChatGPT sign-in."],
      targets: { vps: "#vps-owner-check" },
    },
    probe_rejected: {
      title: "OpenAI refused the test",
      say: "OpenAI refused a model test request without blaming the model. Nothing was recorded.",
      steps: [
        "Try again later.",
        "If it keeps happening, turn model checks off. New models then show in n8n without a test.",
      ],
      targets: { vps: "#vps-owner-models-status" },
    },
    checks_off: {
      title: "Model checks were turned off",
      say: "Checks stopped because they were turned off during a run.",
      steps: ["Nothing to fix.", "Turn model checks on again if you want them."],
    },
    time_limit: {
      title: "Some models still untested",
      say: "Not every model was tested in time. The sidecar keeps testing in the background.",
      steps: ["Nothing to do.", "The rest are tested when n8n next asks for models."],
    },
    lease_unavailable: {
      title: "Session busy during checks",
      say: "The ChatGPT session could not be used for a test just then, for example because plan use is off.",
      steps: ["Check again later.", "Checks resume on a later background run."],
    },
    catalog_unavailable: {
      title: "Model list unavailable",
      say: "The sidecar could not read OpenAI's model list and has no recent copy.",
      steps: [
        "If the message says to retry later, try again later.",
        "If it asks for a sign-in, press Check installed account, and press Refresh ChatGPT sign-in only if the panel asks for a fresh sign-in.",
        "Do not switch accounts or servers because of this.",
      ],
      targets: { vps: "#vps-owner-check" },
    },
    registration_unavailable: {
      title: "Account not ready for plan use",
      say: "The selected ChatGPT account cannot use the plan right now. Plan use may not be allowed yet, or it may be paused.",
      steps: [
        "Check the account's status on the sign-in screen.",
        "Allow or resume plan use if Relmio offers it.",
        "Sign in again if Relmio asks for it.",
      ],
    },
    vps_sidecar_owned: {
      title: "Relmio already runs here",
      say: "A ChatGPT plan sidecar from Relmio already runs on this n8n, so a second install is refused. Update it from its own panel instead.",
      steps: [
        "Open Manage the installed ChatGPT session and press Check installed account.",
        "Press Review sidecar update.",
        "Tick the approval box, then press Update the sidecar.",
      ],
      targets: { vps: "#vps-siwc-owner" },
    },
    vps_sidecar_updating: {
      title: "Finish the sidecar update",
      say: "A sidecar update on this server stopped before it finished. A new install waits until it does.",
      steps: [
        "Open Manage the installed ChatGPT session and press Check installed account.",
        "Press Review sidecar update.",
        "Tick the approval box, then press Update the sidecar.",
      ],
      targets: { vps: "#vps-siwc-owner" },
    },
    vps_sidecar_staged: {
      title: "Finish the earlier install",
      say: "An earlier install on this server stopped partway. Resume it instead of starting another.",
      steps: [
        "Open Recover a transfer or staged installation.",
        "Choose the account and press Review staged resume.",
        "Approve the reviewed plan.",
      ],
      targets: { vps: "#vps-siwc-recovery" },
    },
    vps_sidecar_partial: {
      title: "Finish the earlier migration",
      say: "An earlier migration on this server started but did not finish. A new install waits until it is resolved.",
      steps: [
        "Open Recover a transfer or staged installation.",
        "Review what it finds before you approve anything.",
      ],
      targets: { vps: "#vps-siwc-recovery" },
    },
    "runtime-unavailable": modelRetry("Model runtime not reachable", "The model runtime could not be reached during its check."),
    "invalid-response": modelRetry("Unexpected model reply", "The model runtime answered with something Relmio did not expect."),
    "download-failed": modelRetry("Model download failed", "The model download did not finish. Partial files stay in the cache and use disk."),
    "download-timeout": modelRetry("Model download took too long", "The model download did not finish in time. Partial files stay in the cache."),
    "model-missing": modelRetry("Model not found", "The downloaded model could not be found when Relmio checked it."),
    "model-identity-changed": modelIdentity("Model version changed"),
    "quantization-changed": modelIdentity("Model format changed"),
    "inference-failed": modelRetry("Model test answer failed", "The model downloaded but did not pass its short test answer."),
    "inference-timeout": modelRetry("Model test took too long", "The model took too long to answer its test. Models on a CPU can be slow, most of all on the first load."),
    "context-budget-exceeded": modelRetry("Model used too much context", "The running model used more context than the reviewed plan allows."),
  },
  status: {
    400: {
      title: "Request not accepted",
      say: "Something in this request was not accepted.",
      steps: ["Check the marked box or the value the message names.", "Correct it, then try again."],
    },
    401: {
      title: "Wizard session expired",
      say: "This wizard page's session is no longer valid, often because Relmio was restarted.",
      steps: [
        "Close this page.",
        "Run relmio open, or press Enter in the terminal that runs Relmio.",
        "Continue in the new page.",
      ],
    },
    403: {
      title: "This action is not allowed here",
      say: "Relmio refused this action for this page or session, and the message on the page gives the reason.",
      steps: [
        "Read the error message on the page.",
        "If it names a model-only session, disconnect and connect with a root sign-in the server already allows.",
        "If this is an old wizard tab, close it and run relmio open.",
      ],
    },
    404: {
      title: "Not found",
      say: "Relmio could not find what this step asked for.",
      steps: ["Reload the page.", "If it repeats, run relmio open to get a fresh page."],
    },
    409: {
      title: "Something changed or is busy",
      say: "Another action is still running, or your choice changed since you reviewed it.",
      steps: [
        "Wait for the current action to finish.",
        "Choose your account or target again.",
        "Review again, then try once more.",
      ],
    },
    413: {
      title: "Too much data",
      say: "The request was larger than Relmio accepts.",
      steps: ["Shorten what you entered, then try again."],
    },
    429: {
      title: "Too many attempts",
      say: "Relmio limits repeated sign-in, fingerprint and connection attempts.",
      steps: ["Wait a few minutes.", "Try once more."],
    },
    500: {
      title: "Unexpected problem",
      say: "Relmio hit a problem it did not expect and stopped this step.",
      steps: ["Try the step once more.", "If it repeats, open Troubleshooting in the Relmio docs."],
    },
    502: {
      title: "Reply could not be trusted",
      say: "Your server or a service sent a reply Relmio could not verify, so it stopped.",
      steps: ["Try the step once more.", "If it repeats, open Troubleshooting in the Relmio docs."],
    },
    503: {
      title: "Service unavailable",
      say: "The service is not available right now. Relmio keeps the same account.",
      steps: ["Wait a few minutes.", "Try again with the same account."],
    },
  },
  fallback: {
    title: "Something went wrong",
    say: "Relmio stopped this step. The message explains what happened.",
    steps: [
      "Read the error message on the page.",
      "Fix what it names, then try again.",
      "If it repeats, open Troubleshooting in the Relmio docs.",
    ],
  },
};
