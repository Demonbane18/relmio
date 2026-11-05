// Guide content for the VPS Claude wizard (claude-vps.html). Facts come from
// docs/claude-subscription.md, docs/troubleshooting.md and docs/hosting-compatibility.md.

const wait = (id) => ({
  id,
  target: "#operation-progress",
  action: "wait",
  title: "Wait for this step",
  say: "Relmio is working on your server. Keep this page open until the bar finishes.",
  done: "hidden:#operation-progress",
});

import { HELP_METADATA } from "./context.js";

export const GUIDE = {
  metadata: HELP_METADATA,
  page: "claude-vps",
  title: "Connect n8n on your VPS to Claude",
  intro: "This guide adds a private Claude helper beside n8n on your server and guides you through signing in yourself in your own terminal. You can hide it or skip it at any time.",
  chapters: [
    {
      id: "server",
      label: "Check your server",
      panel: "#ssh-panel",
      badge: "Server checked",
      tips: [
        wait("server-wait"),
        {
          id: "host",
          target: "#host",
          action: "type",
          title: "Type your server address",
          say: "A VPS is a computer you rent that stays on all day in a data center. Type its IP address or name here.",
          example: "203.0.113.10",
          find: "Use the hostname or IP address your provider shows for your server.",
          done: "filled",
        },
        {
          id: "port",
          target: "#port",
          action: "type",
          title: "Check the SSH port",
          say: "SSH is the secure way Relmio logs in to your server to run commands. Keep 22 unless your server uses another SSH port.",
          example: "22",
          done: "filled",
        },
        {
          id: "check",
          target: "#scan-button",
          action: "press",
          title: "Check the server identity",
          say: "Press Check server identity. Relmio reads the server's fingerprint before it sends any password.",
          done: "visible:#fingerprint-box",
        },
        {
          id: "fingerprint",
          target: "#trust-host",
          action: "check",
          title: "Compare the fingerprint",
          say: "A fingerprint is your server's ID card, a long code that only this server has. Compare it with a copy you trust, then tick the box. If it does not match, stop here.",
          find: "Get the fingerprint from your VPS provider or administrator through a channel you trust, such as the provider's console.",
          done: "checked",
        },
        {
          id: "username",
          target: "#username",
          action: "type",
          title: "Your SSH username",
          say: "This route needs root, the server's main administrator account.",
          example: "root",
          done: "filled",
        },
        {
          id: "password",
          target: "#password",
          action: "type",
          title: "Type the server password",
          say: "Type the SSH password for this server. It clears after each attempt. To use an SSH key, choose Local SSH agent in SSH authentication.",
          find: "For a key, load it into your SSH agent with ssh-add before you start Relmio.",
          done: "filled",
        },
        {
          id: "connect",
          target: "#connect-button",
          action: "press",
          title: "Connect and look at n8n",
          say: "Press Connect and inspect n8n. Relmio logs in and looks around without changing anything.",
          done: "clicked",
        },
      ],
    },
{
  "id": "n8n",
  "label": "Choose your n8n",
  "panel": "#selection-panel",
  "badge": "n8n found",
  "tips": [
    {
      "id": "container",
      "target": "#container",
      "action": "choose",
      "title": "Pick your n8n",
      "say": "Choose your running n8n container. The wizard does not edit or restart it.",
      "done": "manual"
    },
    {
      "id": "network",
      "target": "#network",
      "action": "choose",
      "title": "Choose the private network",
      "say": "The Claude companion joins this existing Docker network. No companion port is published.",
      "done": "manual"
    },
    {
      "id": "install",
      "target": "#selection-panel [data-action=install]",
      "action": "press",
      "title": "Review installation",
      "say": "Review the model choices and four owner questions before seeing the final plan. Nothing is written yet.",
      "done": "clicked"
    },
    {
      "id": "replace",
      "target": "#selection-panel [data-action=replace]",
      "action": "press",
      "title": "Review replacement",
      "say": "Replacement keeps the Claude login volume but creates a new n8n key. Save that new key in n8n afterward.",
      "done": "clicked"
    },
    {
      "id": "continue",
      "target": "#selection-continue",
      "action": "press",
      "title": "Manage installed Claude",
      "say": "Continue to see the terminal sign-in command, approval expiry and n8n settings.",
      "done": "clicked"
    }
  ]
},
{
  "id": "approval",
  "label": "Review Claude use",
  "panel": "#approval-panel",
  "badge": "Owner review complete",
  "tips": [
    {
      "id": "pin",
      "target": "#candidate-sha",
      "action": "read",
      "title": "Check the official binary",
      "say": "Compare the version and SHA-256 with the official release you reviewed. A matching checksum alone does not establish permission.",
      "done": "manual"
    },
    {
      "id": "choose-models",
      "target": "#model-choices",
      "action": "choose",
      "title": "Choose approved models",
      "say": "Choose the models you reviewed for your own plan. Fable is refused; listed choices do not establish account access.",
      "done": "manual"
    },
    {
      "id": "binary",
      "target": "[data-review=officialBinaryReviewed]",
      "action": "check",
      "title": "Review the binary",
      "say": "Tick only after reviewing the official binary and checksum.",
      "done": "checked"
    },
    {
      "id": "policy",
      "target": "[data-review=effectivePolicyReviewed]",
      "action": "check",
      "title": "Review the effective policy",
      "say": "Confirm that the effective policy permits your personal use.",
      "done": "checked"
    },
    {
      "id": "billing",
      "target": "[data-review=nativeAuthAndBillingReviewed]",
      "action": "check",
      "title": "Review sign-in and billing",
      "say": "Use your own Claude Pro or Max plan with extra usage off. You complete sign-in in your own terminal.",
      "done": "checked"
    },
    {
      "id": "changes",
      "target": "[data-review=policyChangesControlled]",
      "action": "check",
      "title": "Keep reviewed settings unchanged",
      "say": "Keep the reviewed runtime and policy unchanged. Approval expires within 7 days; renew it after another review.",
      "done": "checked"
    },
    {
      "id": "prepare",
      "target": "#prepare-button",
      "action": "press",
      "title": "Review the final plan",
      "say": "This sends your review choices for a read-only plan. Installation still needs a separate final confirmation.",
      "done": "clicked"
    }
  ]
},
{
  "id": "review",
  "label": "Confirm the plan",
  "panel": "#review-panel",
  "badge": "Plan confirmed",
  "tips": [
    {
      "id": "summary",
      "target": "#review-summary",
      "action": "read",
      "title": "Check the exact action",
      "say": "Check the server, network, models, binary pin and expiry. Removal deletes the saved Claude login; replacement keeps it.",
      "done": "manual"
    },
    {
      "id": "confirm",
      "target": "#confirm-action",
      "action": "check",
      "title": "Approve this one action",
      "say": "Tick only if you approve this exact action on the Claude companion. Existing n8n stays unchanged.",
      "done": "checked"
    },
    {
      "id": "apply",
      "target": "#apply-button",
      "action": "press",
      "title": "Apply the reviewed action",
      "say": "Press the action button and wait for its result. Do not close the wizard while it works.",
      "done": "clicked"
    }
  ]
},
{
  "id": "connect",
  "label": "Sign in and connect",
  "panel": "#settings-panel",
  "badge": "Connection reviewed",
  "tips": [
    {
      "id": "command",
      "target": "#copy-login",
      "action": "press",
      "title": "Copy the terminal command",
      "say": "Run this command in your own terminal and follow official Claude sign-in there. Never paste a Claude login code into the wizard.",
      "done": "clicked"
    },
    {
      "id": "auth",
      "target": "#auth-button",
      "action": "press",
      "title": "Check Claude sign-in",
      "say": "This reads only sign-in state, method and subscription type. A successful sign-in is separate from a successful model request.",
      "done": "clicked"
    },
    {
      "id": "key",
      "target": "#copy-key",
      "action": "press",
      "title": "Save the n8n key",
      "say": "This separate key lets n8n reach the companion. It appears only after install or replacement; save it in your OpenAI credential.",
      "done": "clicked"
    },
    {
      "id": "settings",
      "target": "#n8n-settings",
      "action": "read",
      "title": "Set up the text workflow",
      "say": "Use Basic LLM Chain and OpenAI Chat Model with Responses API off, Max Retries 0, Timeout at least 135000 ms and Batch Size 1. Text only, one request at a time; not AI Agent tools or the n8n AI Assistant.",
      "done": "manual"
    },
    {
      "id": "models",
      "target": "#models-button",
      "action": "press",
      "title": "Check approved models",
      "say": "Enter your saved n8n API key and check models. A model listing does not prove a workflow succeeds.",
      "done": "clicked"
    },
    {
      "id": "expiry",
      "target": "#approval-expiry",
      "action": "read",
      "title": "Check approval expiry",
      "say": "Approval expires within 7 days. Open Manage companion and login storage to renew it after reviewing again.",
      "done": "manual"
    },
    {
      "id": "renew",
      "target": "#settings-panel [data-action=renew]",
      "action": "press",
      "title": "Renew approval",
      "say": "Review all four owner questions again and confirm the final plan. Only the Claude companion restarts.",
      "done": "clicked"
    },
    {
      "id": "sign-out",
      "target": "#settings-panel [data-action=sign-out]",
      "action": "read",
      "title": "Sign out of Claude",
      "say": "Review and confirm to sign out only this companion. Other accounts and n8n stay unchanged.",
      "done": "manual"
    },
    {
      "id": "remove",
      "target": "#settings-panel [data-action=remove]",
      "action": "read",
      "title": "Remove the Claude companion",
      "say": "Review and confirm removal of the companion, its files and its saved Claude login. Existing n8n stays unchanged.",
      "done": "manual"
    }
  ]
}
  ],
  finish: {
  "title": "Check your workflow",
  "say": "The wizard checks installation, sign-in and model listing separately. Test a short text workflow in n8n before relying on it.",
  "next": [
    "Save the private Base URL and n8n key in an OpenAI credential",
    "Use the required text-only n8n settings",
    "Renew approval before it expires"
  ]
}
};
