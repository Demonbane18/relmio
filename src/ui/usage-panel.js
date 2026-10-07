// Plan and usage: the VPS owner panel, the /local dashboard section and the local
// installed view. Pages fetch the data; this module only builds the DOM, always with
// textContent. The counts are the text requests the sidecar relays; model checks and image
// requests are not counted. OpenAI documents no plan percent, reset time or credits for this
// sign-in, so none are shown or derived.

const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
const STATES = new Set(["ok", "empty", "unavailable"]);
const TOTALS = ["requests", "completed", "failed", "incomplete", "total"];
const SHOWN_MODELS = 3;

// The stylesheet loads with this module, so a page that never shows the panel loads neither.
// The import resolves only once the stylesheet has loaded, so the panel never renders unstyled.
if (globalThis.document?.head) {
  await new Promise((resolve) => {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/usage-panel.css" });
    link.addEventListener("load", resolve);
    link.addEventListener("error", resolve);
    document.head.append(link);
  });
}

// The four plan-usage codes the sidecar keeps: [title, next step, Manage usage is the recovery].
const EVENTS = Object.freeze({
  subscription_sharing_usage_limit_exceeded: ["Usage limit reached",
    "Pause the n8n workflows that use this account and open Manage usage. The limit can be your plan's, or one you set for this app in ChatGPT.", true],
  subscription_sharing_usage_unavailable: ["Usage could not be checked",
    "OpenAI could not check plan usage just then. This does not mean a limit was reached. Try again later with the same account."],
  subscription_sharing_user_unavailable: ["Account details were unavailable",
    "OpenAI could not read this account or workspace just then. Try again later with the same account."],
  subscription_sharing_user_not_eligible: ["Plan use not available",
    "OpenAI said plan use is not available for this account, workspace or policy. Check that this is the account you meant to use. Signing in again does not change it."],
});
// Image requests are not counted on either page. The local sidecar runs no model checks, so only
// the VPS strings mention them.
const MESSAGES = {
  vps: {
    idle: "Press Refresh usage to read this sidecar's request counts.",
    empty: "No requests counted in the last 30 days. A sidecar from this Relmio version counts each text request n8n sends through it. Model checks and image requests are not counted. An older sidecar counts nothing until you update it with Review sidecar update above.",
    unavailable: "The request counts could not be read, so none are shown. Press Refresh usage to try again.",
    409: "Press Check installed account again, then Refresh usage. The account check lasts five minutes.",
    note: "These are Relmio's counts of text requests through the sidecar. Model checks and image requests are not counted, and ChatGPT measures plan usage its own way. Plan limits, reset times and credits stay in ChatGPT. ",
  },
  local: {
    idle: "Press Refresh usage to read the request counts.",
    empty: "No requests counted in the last 30 days. A sidecar from this Relmio version counts each text request it sends to OpenAI. Image requests are not counted. An older sidecar counts nothing until it is updated.",
    unavailable: "The request counts could not be read, so none are shown. Check that the sidecar is running, then press Refresh usage.",
    409: "The dashboard changed while the counts were read. Press Refresh usage again.",
    note: "These are Relmio's counts of text requests through the sidecar. Image requests are not counted, and ChatGPT measures plan usage its own way. Plan limits, reset times and credits stay in ChatGPT. ",
  },
};
const RATE_LIMITED = "Relmio can read the counts 10 times in 15 minutes. Wait a few minutes, then press Refresh usage.";

const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const time = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// The server's bounded view when every field this panel shows is well formed. Anything else
// reads as unavailable, so a half-valid view is never shown.
function readView(value) {
  const valid = STATES.has(value?.state) && TOTALS.every((key) => whole(value.totals?.[key])) &&
    whole(value.activeDays) && Array.isArray(value.models) &&
    value.models.every((model) => typeof model?.id === "string" && whole(model.requests) && whole(model.total)) &&
    (value.state !== "ok" || (time(value.since) && time(value.updatedAt) && value.models.length > 0)) &&
    (value.peakDay === null || (time(value.peakDay?.date) && whole(value.peakDay.total))) &&
    (value.lastUsageEvent === null || (time(value.lastUsageEvent?.at) && Object.hasOwn(EVENTS, value.lastUsageEvent.code)));
  return valid ? value : { state: "unavailable", lastUsageEvent: null };
}

function formats(locale) {
  const number = new Intl.NumberFormat(locale);
  // Counts are kept per UTC day, so a day is shown in UTC and a moment in local time.
  const day = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  const moment = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const count = (value) => number.format(value);
  return {
    count,
    counted: (value, word) => `${count(value)} ${word}${value === 1 ? "" : "s"}`,
    day: (value) => day.format(new Date(`${value.slice(0, 10)}T00:00:00Z`)),
    moment: (value) => moment.format(new Date(value)),
  };
}

function node(tag, className = "", text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function decoration(className) {
  const item = node("span", className);
  item.setAttribute("aria-hidden", "true");
  return item;
}

function group(className, items) {
  const box = node("div", className);
  box.append(...items);
  return box;
}

function manageLink(className) {
  const link = node("a", className, "Manage usage");
  link.href = MANAGE_USAGE_URL;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.append(decoration("rm-icon rm-icon--external rm-icon--xs"), node("span", "rm-visually-hidden", " (opens in a new tab)"));
  return link;
}

function terms(className, rows) {
  const list = node("dl", className);
  for (const [term, value, hint] of rows) {
    const detail = node("dd", "", value);
    if (hint) detail.append(node("span", "usage-panel__hint", ` ${hint}`));
    list.append(group("", [node("dt", "", term), detail]));
  }
  return list;
}

const planUse = (account) => account.session === "reauthorize" ? "Needs a fresh sign-in"
  : account.session !== "connected" ? "Signed out"
  : account.planEnabled ? "On" : account.planPermission === "granted" ? "Paused" : "Not allowed yet";

function facts({ account, imagePlan, models }, view, format) {
  const rows = [];
  if (account) {
    rows.push(["Account", account.email ? `${account.label} (${account.email})` : account.label], ["Plan use", planUse(account)]);
  }
  if (imagePlan) {
    rows.push(["Image add-on plan type", imagePlan,
      "From the image add-on's separate Codex sign-in. OpenAI does not document this value for other apps."]);
  }
  // Without model checks (local), a model with tokens in the window completed a request through Relmio.
  const answered = view?.state === "ok" ? view.models.filter((model) => model.id !== "other" && model.total > 0).length : null;
  const modelText = [
    whole(models?.listed) ? `${format.count(models.listed)} listed by OpenAI` : "",
    whole(models?.verified) ? `${format.count(models.verified)} verified by a completed request`
      : answered === null ? "" : `${format.count(answered)} verified by a completed request in the last 30 days`,
  ].filter(Boolean).join(" · ");
  if (modelText) rows.push(["Models", modelText]);
  return rows.length ? [terms("rm-dl usage-panel__facts", rows)] : [];
}

function modelList(label, models, scale, format) {
  const list = node("ul", "usage-panel__models");
  list.setAttribute("aria-label", label);
  for (const model of models) {
    const track = decoration("rm-progress usage-panel__bar");
    const bar = node("span", "rm-progress__bar");
    // Decoration sized against the busiest model; the text beside it carries the values.
    bar.style.setProperty("--rm-progress", `${Math.max(2, Math.round((scale.of(model) / scale.max) * 100))}%`);
    track.append(bar);
    const item = node("li", "usage-panel__model");
    item.append(model.id === "other" ? node("span", "usage-panel__model-name", "Other models")
      : node("code", "usage-panel__model-name", model.id),
    node("span", "usage-panel__model-value", `${format.counted(model.requests, "request")} · ${format.counted(model.total, "token")}`),
    track);
    list.append(item);
  }
  return list;
}

function counts(view, format) {
  const { totals: sum, models } = view;
  const cancelled = sum.requests - sum.completed - sum.failed - sum.incomplete;
  const outcomes = [`${format.count(sum.completed)} completed`, `${format.count(sum.failed)} failed`,
    `${format.count(sum.incomplete)} incomplete`, ...(cancelled > 0 ? [`${format.count(cancelled)} cancelled`] : [])];
  const tokens = Math.max(...models.map((model) => model.total));
  const scale = tokens ? { max: tokens, of: (model) => model.total }
    : { max: Math.max(1, ...models.map((model) => model.requests)), of: (model) => model.requests };
  const items = [
    node("p", "usage-panel__label", "Text requests through the sidecar, last 30 days"),
    terms("usage-panel__totals", [
      ["Requests", format.count(sum.requests)],
      // The qualifier sits in the label: a hint line here would make the totals row taller.
      ["Tokens (completed)", format.count(sum.total)],
      ["Active days", format.count(view.activeDays), "of the last 30"],
      ["Peak day", view.peakDay ? format.day(view.peakDay.date) : "No tokens yet",
        view.peakDay ? format.counted(view.peakDay.total, "token") : ""],
    ]),
    node("p", "rm-small rm-muted", `${outcomes.join(" · ")}. Counted since ${format.day(view.since)}, by UTC day.`),
    node("p", "usage-panel__label", "By model"),
    modelList("Requests and tokens by model", models.slice(0, SHOWN_MODELS), scale, format),
  ];
  if (models.length > SHOWN_MODELS) {
    const more = node("details", "rm-disclosure rm-disclosure--plain");
    more.append(node("summary", "", `${format.count(models.length - SHOWN_MODELS)} more models`),
      group("rm-disclosure__body", [modelList("More models", models.slice(SHOWN_MODELS), scale, format)]));
    items.push(more);
  }
  return items;
}

function usageEvent(event, format) {
  const [title, next, manage] = EVENTS[event.code];
  const status = node("p", "rm-status");
  status.setAttribute("data-tone", "warning");
  status.append(decoration("rm-status__dot"), node("span", "", `Last plan usage event: ${title}, ${format.moment(event.at)}.`));
  return group("usage-panel__event", [status, node("p", "rm-small", next), ...(manage ? [manageLink("rm-button rm-button--sm")] : [])]);
}

function statusText(info, view, format) {
  const messages = MESSAGES[info.page];
  if (info.loading) return "Reading request counts…";
  if (info.error) {
    const kept = view?.state === "ok" ? ` The counts shown are from ${format.moment(view.updatedAt)}.` : "";
    if (info.error.status === 429) return RATE_LIMITED + kept;
    if (info.error.status === 409) return messages[409] + kept;
    return `${info.error.message || "The request counts could not be read."} Press Refresh usage to try again.${kept}`;
  }
  if (!view) return messages.idle;
  return view.state === "ok" ? `Updated ${format.moment(view.updatedAt)}.` : messages[view.state];
}

// parts: { status, view } elements; status is the panel's polite live region.
// info: { page: "vps" | "local", account, imagePlan, models: { listed, verified }, usage, error, loading, locale }.
// A failed refresh keeps the last view on screen and explains itself in the status line.
export function renderUsage(parts, info) {
  const format = formats(info.locale);
  const view = info.usage ? readView(info.usage) : null;
  const note = node("p", "usage-panel__note", MESSAGES[info.page].note);
  note.append(manageLink("rm-link"));
  // Counts read first; the account, the last plan event and the note sit beside them when wide.
  const about = [...facts(info, view, format), ...(view?.lastUsageEvent ? [usageEvent(view.lastUsageEvent, format)] : []), note];
  parts.status.textContent = statusText(info, view, format);
  parts.view.replaceChildren(...(view?.state === "ok" ? [group("usage-panel__group", counts(view, format))] : []),
    group("usage-panel__group", about));
}
