// Error help for the setup guide. Facts come from docs/troubleshooting.md, docs/vps-and-n8n.md,
// docs/local-models.md and docs/local-n8n-stack.md. The engine checks boolean flags, then
// codes[code | errorCode | stoppedReason], then recovery, then status, then fallback.

const MODEL_RETRY = { local: "#local-model-review-retry", "local-model-vps": "#review-retry" };
const FINGERPRINT = {
  vps: "#fingerprint-button",
  assistant: "#fingerprint-button",
  "supergrok-vps": "#scan-button",
  "local-model-vps": "#scan",
};
const USAGE = { vps: "#global-error-recovery", local: "#global-error-recovery" };

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
        "Read the plan notice and press Continue.",
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
      say: "A server command ran out of time, so Relmio cannot tell whether it finished. It does not retry on its own.",
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
    NO_RUNNING_N8N: {
      title: "No running n8n found",
      say: "Relmio could not find a running n8n on this server. You can still check a model Relmio installed earlier.",
      steps: [
        "Start n8n the way you normally do, then connect again.",
        "Or type the original n8n container and network names.",
        "Press Inspect owned model.",
      ],
      targets: { "local-model-vps": "#manual-container" },
    },
    ssh_identity_review_required: {
      title: "Check the server again",
      say: "The server identity check was already used or no longer matches. Relmio needs a fresh check before it connects.",
      steps: [
        "Press the server identity check again.",
        "Compare the new fingerprint with your trusted copy.",
        "Tick the box, then connect.",
      ],
      targets: FINGERPRINT,
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
      title: "Request blocked",
      say: "Relmio accepts requests only from its own wizard page.",
      steps: ["Close old wizard tabs.", "Run relmio open to get a fresh page."],
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
