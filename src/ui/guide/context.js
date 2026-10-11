// Bundled, deterministic help. No account identifiers, credentials, network
// lookup, model calls or saved question history enter this module.
export const HELP_METADATA = Object.freeze({
  schema: 1,
  revision: 1,
  sourceVersion: "0.22.1",
  sourceCommit: "b6b4c2ac4e6b055fa22a9feeac757fb9bb2ac2bd",
  reviewedOn: "2026-10-11",
  sources: Object.freeze([
    "docs/getting-started.md", "docs/faq.md", "docs/security.md",
    "docs/vps-and-n8n.md", "docs/local-dashboard.md", "docs/troubleshooting.md",
    "docs/contextual-help-source-check-2026-10-11.md",
  ]),
});

export function validHelpMetadata(value) {
  if (!value || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > HELP_METADATA.revision ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(value.sourceVersion ?? "") ||
      !/^[a-f0-9]{40}$/u.test(value.sourceCommit ?? "") ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(value.reviewedOn ?? "") ||
      !Array.isArray(value.sources) || !value.sources.length ||
      !value.sources.every((path) => /^docs\/[a-z0-9-]+\.md$/u.test(path))) return false;
  if (value.sourceVersion !== HELP_METADATA.sourceVersion || value.sourceCommit !== HELP_METADATA.sourceCommit ||
      value.reviewedOn > HELP_METADATA.reviewedOn) return false;
  const date = Date.parse(`${value.reviewedOn}T00:00:00Z`);
  return Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === value.reviewedOn;
}

export const UNKNOWN_HELP = Object.freeze({
  id: "unknown", title: "Check the current view",
  say: "This help cannot confirm the prerequisite for this view. Read its status and visible instructions before continuing.",
  steps: ["Use the current step's controls and documentation. Keep every review and confirmation in place."],
  target: null,
});

const entry = (id, title, say, target, steps = []) => Object.freeze({ id, title, say, target, steps });
export const HELP_FAQ = Object.freeze([
  entry("identity", "Is sign-in enough?", "Verified identity, permission to use a ChatGPT plan and a completed model request are separate checks. Sign-in does not create a Platform API key.", null),
  entry("usage", "What does usage mean?", "Plan and usage counts requests through the Relmio sidecar. It does not show your plan percent, credits or reset time; use Manage usage for ChatGPT's own usage page.", null),
  entry("models", "Does a listed model work?", "A model listing does not prove admission or a completed response. Check the installed account and use only the available checks; account limits still apply.", null),
  entry("transfer", "Who manages a transferred sign-in?", "The reviewed installation owns refresh after transfer. Use its installed account controls; another installation needs its own registration and approval.", null),
  entry("server", "Why check the server identity?", "Compare the SSH fingerprint with a trusted record before connecting. The guide cannot verify it for you or approve the server.", null),
  entry("install", "Will Show me install anything?", "Show me only highlights a control and moves focus. You still review the destination, background activity and final installation confirmation yourself.", null),
  entry("features", "Where is help for this feature?", "Current step lists this view's controls, including optional features once you open them. Select a tip for its instructions, then choose Show me.", null),
]);

// Bounded enum/boolean input only. Priority follows the controls' real state,
// never the wording of a server error or an account's display label.
export function contextualHelp(state = {}, metadata = HELP_METADATA) {
  if (!validHelpMetadata(metadata)) return UNKNOWN_HELP;
  if (state.busy === true) return entry("busy", "Wait for the current operation", "Controls are locked while this operation runs. Keep the page open and wait for its result before continuing.", "#operation-progress");
  if (state.preview === true) return entry("preview", "This is a sanitized preview", "Live sign-in and installation are disabled in this preview. The example account is not evidence of a live connection.", "[data-siwc=state]");
  if (state.accountState === "handoff-pending") return entry("ownership-pending", "Resolve the destination ownership", "The transfer is unresolved, so plan requests stay frozen. Open Recover or manage an installation and review the exact destination before any confirmation.", "[data-siwc=recover]");
  if (state.accountState === "transferred") return entry("ownership-transferred", "Use the installed account controls", "This registration belongs to its installation and cannot be reused here. Open Recover or manage an installation, or use Continue with ChatGPT for a separate installation.", "[data-siwc=recover]");
  if (state.accountState === "host-unavailable") return entry("ownership-host", "Connect an account on this computer", "This registration belongs to another host or runtime. Use Continue with ChatGPT to create a registration here.", "[data-siwc=new]");
  if (state.accountState === "reauthorize" || state.accountState === "signed-out") return entry("sign-in-again", "Sign in again", "This account needs a fresh sign-in. Choose Sign in again; separate plan permission and the existing plan setting still apply.", "[data-siwc=return]");
  if (state.accountState === "identity-only") return entry("permission", "Allow ChatGPT plan use", "Identity is connected, but ChatGPT plan permission has not been granted. Choose Allow ChatGPT plan use and review the separate consent on the ChatGPT page before continuing.", "[data-siwc=grant]");
  if (state.accountState === "plan-paused") return entry("paused", "Choose whether to use the plan", "ChatGPT plan permission is granted, but plan use is paused in Relmio. Choose Use ChatGPT plan only if you want this account to use its plan.", "[data-siwc=resume]");
  if (state.accountState === "plan-active" && state.usageLimited === true) return entry("usage-limit", "Manage the account usage", "Plan requests are paused because the usage limit was reached. Choose Manage usage; Relmio does not switch accounts or billing.", "[data-siwc=usage]");
  if (state.accountState === "plan-active" && state.noticePending === true) return entry("acknowledgment", "Review the plan notice", "Plan use is granted. Choose Review plan notice and read You're using your ChatGPT plan, then choose Got it before continuing.", "[data-siwc=welcome-open], [data-siwc=welcome-accept]");
  if (state.accountState === "new") return state.pending === true
    ? entry("pending-sign-in", "Finish the unfinished sign-in", "An unfinished sign-in is not an authenticated account. Select it under Unfinished sign-in, then choose Finish sign-in, or start Continue with ChatGPT.", "[data-siwc=finish]")
    : entry("sign-in", "Continue with ChatGPT", "Choose Continue with ChatGPT to connect an account. Identity and plan permission are checked separately before you can continue.", "[data-siwc=new]");
  if (state.accountState !== undefined && state.accountState !== "plan-active") return UNKNOWN_HELP;
  return null;
}

export function helpState(root, body) {
  const data = root?.dataset ?? {};
  return {
    busy: body?.dataset?.operationBusy === "true" || data.guideBusy === "true",
    preview: data.guidePreview === "true", accountState: data.guideAccountState,
    noticePending: data.guidePlanNotice === "true", usageLimited: data.guideUsageLimited === "true",
    pending: data.guidePending === "true",
  };
}
