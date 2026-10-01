import { createHostingArchive } from "./hosting-archive.js";
import { bindWizardNavigation, readWizardSession } from "./session.js";
import { initWizardTopbar } from "./topbar.js";

const token = readWizardSession();
const el = (id) => document.getElementById(id);
const COMPONENTS = Object.freeze({
  model: "Local model", openai: "OpenAI bridge", assistant: "AI Assistant",
  searxng: "SearXNG", supergrok: "SuperGrok", endpoint: "External endpoint",
});
const MANAGED_ROUTES = Object.freeze({
  "managed-vm": { model: "/local-model-vps", openai: "/", assistant: "/assistant", searxng: "/assistant", supergrok: "/supergrok-vps" },
  local: { model: "/local", openai: "/local", assistant: "/local", searxng: "/local", supergrok: "/local" },
});
const KIND_LABELS = Object.freeze({
  "managed-vm": "Linux VMs", local: "Local Docker",
  "manual-platform": "Container platforms", "external-only": "External services",
});
const MODE_LABELS = Object.freeze({ managed: "Managed", manual: "Manual", external: "External", unavailable: "None" });
const FILE_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.dockerignore)(?:\/(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.dockerignore))*$/u;
const state = { providers: [], profiles: [], models: [], generation: 0, plan: null, archive: null, requestPending: false };

const VIEW_HEADINGS = Object.freeze({ choose: "matrix-title", details: "details-title", review: "review-title" });

function focusVisible(target) {
  target.focus({ preventScroll: true });
  const rect = target.getBoundingClientRect();
  const footer = target.closest(".rm-panel")?.querySelector(".rm-panel__footer");
  const bottom = footer && getComputedStyle(footer).position === "sticky"
    ? Math.min(innerHeight, footer.getBoundingClientRect().top) : innerHeight;
  if (rect.top < document.querySelector(".rm-topbar").getBoundingClientRect().bottom || rect.bottom > bottom) {
    target.scrollIntoView({ block: "start", behavior: "instant" });
  }
}

function showView(view) {
  for (const name of Object.keys(VIEW_HEADINGS)) el(`hosting-${name}`).hidden = name !== view;
  document.body.dataset.hostingView = view;
  focusVisible(el(VIEW_HEADINGS[view]));
}

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function error(message) {
  el("hosting-error").textContent = message;
  el("hosting-error").hidden = false;
  el("hosting-error").focus();
}

function clearError() {
  el("hosting-error").textContent = "";
  el("hosting-error").hidden = true;
}

function invalidate() {
  if (state.plan || state.requestPending) {
    el("hosting-status").textContent = "Selection changed. Review a new plan before downloading.";
  }
  state.generation++;
  state.plan = null;
  state.archive = null;
  state.requestPending = false;
  el("hosting-review").hidden = true;
  el("hosting-review-details").open = false;
  el("hosting-files").replaceChildren();
  el("hosting-generate").disabled = !activeProfile();
  el("hosting-continue").disabled = !activeProfile();
  clearError();
}

function activeProvider() {
  return state.providers.find((provider) => provider.id === el("hosting-provider").value) ?? null;
}

function activeProfile() {
  const provider = activeProvider();
  const component = el("hosting-component").value;
  return provider && provider.components?.[component]?.mode === "manual"
    ? state.profiles.find((profile) => profile.providerId === provider.id && profile.component === component) ?? null
    : null;
}

function option(value, label) {
  const entry = node("option", label);
  entry.value = value;
  return entry;
}

const MODE_ORDER = Object.keys(MODE_LABELS);
const MODE_ICONS = Object.freeze({ managed: "check-circle", manual: "download", external: "external" });

function modeOf(provider, component) {
  return provider.components?.[component]?.mode ?? "unavailable";
}

function modeBadge(mode) {
  return node("span", MODE_LABELS[mode] ?? mode, mode === "managed" ? "rm-badge rm-badge--accent" : "rm-badge");
}

function experimentalBadge() {
  return node("span", "Experimental", "rm-badge rm-badge--accent");
}

// Compact cell: one icon per mode (shapes are explained by #hosting-legend),
// with the mode name as visually hidden text for screen readers.
function modeMark(mode) {
  const mark = node("span", undefined, "hosting-mark");
  mark.dataset.mode = mode;
  if (MODE_ICONS[mode]) {
    const icon = node("span", undefined, `rm-icon rm-icon--${MODE_ICONS[mode]} rm-icon--sm`);
    icon.setAttribute("aria-hidden", "true");
    mark.append(icon);
  }
  mark.append(node("span", MODE_LABELS[mode] ?? mode, "rm-visually-hidden"));
  return mark;
}

function modeCell(modes) {
  const cell = node("td");
  cell.dataset.mode = modes.length === 1 ? modes[0] : "varies";
  if (modes.length > 1) cell.append(node("span", "Varies: ", "rm-visually-hidden"));
  modes.forEach((mode, index) => {
    if (index > 0) cell.append(node("span", " or ", "rm-visually-hidden"));
    cell.append(modeMark(mode));
  });
  return cell;
}

function matrixRow(label, modes, { count = 0, selected = false, experimental = false } = {}) {
  const row = node("tr");
  row.dataset.selected = String(selected);
  const heading = node("th");
  heading.scope = "row";
  if (selected) heading.append(node("span", "Selected: ", "rm-visually-hidden"));
  heading.append(node("span", label));
  if (count > 1) {
    heading.append(" ", node("span", String(count), "hosting-matrix__count"), node("span", " hosts", "rm-visually-hidden"));
  }
  if (experimental) heading.append(" ", experimentalBadge());
  row.append(heading, ...modes.map(modeCell));
  return row;
}

function providersByKind() {
  const groups = new Map();
  for (const provider of state.providers) {
    if (!groups.has(provider.kind)) groups.set(provider.kind, []);
    groups.get(provider.kind).push(provider);
  }
  return groups;
}

// One row per hosting type keeps the comparison on one screen. The chosen
// provider gets its own row under its type with its exact availability.
function renderMatrix() {
  const selectedId = el("hosting-provider").value;
  const rows = [];
  for (const [kind, providers] of providersByKind()) {
    const single = providers.length === 1;
    const selected = providers.find((provider) => provider.id === selectedId) ?? null;
    const modes = Object.keys(COMPONENTS).map((component) => {
      const found = new Set(providers.map((provider) => modeOf(provider, component)));
      return MODE_ORDER.filter((mode) => found.has(mode));
    });
    rows.push(matrixRow(single ? providers[0].label : KIND_LABELS[kind] ?? kind, modes, {
      count: providers.length,
      selected: single && Boolean(selected),
      experimental: providers.every((provider) => !provider.tested),
    }));
    if (selected && !single) {
      rows.push(matrixRow(selected.label, Object.keys(COMPONENTS).map((component) => [modeOf(selected, component)]), { selected: true, experimental: !selected.tested }));
    }
  }
  el("hosting-matrix").replaceChildren(...rows);
}

function renderSources(target, sources) {
  const links = sources.filter((source) => {
    try { return new URL(source.url).protocol === "https:"; } catch { return false; }
  }).map((source) => {
    const link = node("a", source.label, "rm-link");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const icon = node("span", undefined, "rm-icon rm-icon--external rm-icon--xs");
    icon.setAttribute("aria-hidden", "true");
    link.append(icon, node("span", " (opens in a new tab)", "rm-visually-hidden"));
    return link;
  });
  target.replaceChildren(...links);
}

function renderProvider() {
  invalidate();
  const provider = activeProvider();
  renderMatrix();
  el("hosting-component").replaceChildren(option("", "Choose what to set up"));
  el("hosting-component").disabled = !provider;
  if (provider) {
    for (const [component, label] of Object.entries(COMPONENTS)) {
      if (provider.components?.[component]) el("hosting-component").append(option(component, label));
    }
  }
  el("hosting-provider-experimental").hidden = !provider || provider.tested === true;
  el("hosting-hint").textContent = provider
    ? `${provider.sshHint} Catalog reviewed ${provider.reviewedOn}; runtime NOT-RUN.`
    : "Choose hosting to see what it supports.";
  renderSources(el("hosting-sources"), provider?.sources ?? []);
  renderComponent();
}

function renderComponent() {
  invalidate();
  const provider = activeProvider();
  const component = el("hosting-component").value;
  const capability = provider?.components?.[component];
  const profile = activeProfile();
  if (capability) {
    el("hosting-capability").replaceChildren(modeBadge(capability.mode), " ", node("span", capability.note));
  } else {
    el("hosting-capability").textContent = "Choose what to set up to see what's available.";
  }
  const route = provider && MANAGED_ROUTES[provider.kind]?.[component];
  const oldLink = el("hosting-managed-link");
  const managedLink = oldLink.cloneNode(false);
  oldLink.replaceWith(managedLink);
  managedLink.hidden = !(capability?.mode === "managed" && route);
  if (!managedLink.hidden) {
    bindWizardNavigation(managedLink, route, token);
    managedLink.textContent = "Open managed setup";
  }
  el("hosting-continue").hidden = !managedLink.hidden;
  el("hosting-model-wrap").hidden = !(profile && component === "model");
  el("hosting-model").disabled = el("hosting-model-wrap").hidden;
  el("hosting-model").required = !el("hosting-model-wrap").hidden;
  el("hosting-model").replaceChildren(
    option("", "Choose an approved model"),
    ...state.models.map((model) => option(model.id, `${model.label} · ${model.quantization}`)),
  );
  el("hosting-inputs").replaceChildren(...(profile?.fields ?? []).map(renderField));
  el("hosting-no-inputs").hidden = !profile || profile.fields.length > 0 || component === "model";
  el("hosting-limits").textContent = profile
    ? "Check provider access, private routing, resources, storage, and your existing n8n connection before using these files."
    : capability?.mode === "managed"
      ? provider.kind === "managed-vm"
        ? "Open setup to verify the server fingerprint (its identity) before connecting, then confirm the exact plan before any remote writes."
        : "Open local setup to review the plan and confirm before any changes."
      : capability
        ? "No complete manual plan is available for this route."
        : "";
  el("hosting-generate").disabled = !profile;
  el("hosting-continue").disabled = !profile;
}

function renderField(field, index) {
  const id = `hosting-input-${index}`;
  const wrapper = node("div", undefined, "rm-field");
  const label = node("label", field.label, "rm-field__label");
  label.htmlFor = id;
  const input = document.createElement(field.type === "select" ? "select" : "input");
  input.id = id;
  input.className = field.type === "select" ? "rm-select" : "rm-input";
  input.name = field.name;
  input.required = field.required === true;
  if (field.type === "select") {
    if (field.defaultValue === undefined) input.append(option("", field.required ? "Choose an option" : "Not specified"));
    for (const choice of field.options ?? []) input.append(option(choice.value, choice.label));
    if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
  } else {
    input.type = field.type === "number" ? "number" : "text";
    input.autocomplete = "off";
    if (field.pattern) input.pattern = field.pattern;
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
  }
  wrapper.append(label, input);
  if (field.description) {
    const hint = node("p", field.description, "rm-field__hint");
    hint.id = `${id}-hint`;
    input.setAttribute("aria-describedby", hint.id);
    wrapper.append(hint);
  }
  return wrapper;
}

function randomDeploymentId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function planInputs(profile) {
  const values = {};
  for (const field of profile.fields) {
    const input = [...el("hosting-inputs").querySelectorAll("[name]")].find((item) => item.name === field.name);
    if (!input) throw new Error("The selected input is no longer available.");
    const value = input.value.trim();
    if (value !== "") {
      const choice = field.type === "select"
        ? field.options?.find((entry) => String(entry.value) === value)
        : null;
      values[field.name] = field.type === "number" || typeof choice?.value === "number"
        ? Number(value) : value;
    }
  }
  return values;
}

function appendList(id, items) {
  el(id).replaceChildren(...items.map((item) => node("li", item)));
}

function appendFacts(target, entries) {
  target.replaceChildren(...entries.flatMap(([name, value]) => {
    const description = node("dd");
    description.append(...[value].flat());
    return [node("dt", name), description];
  }));
}

function validFile(file) {
  return file && typeof file.name === "string" && FILE_NAME.test(file.name) &&
    file.name.split("/").every((part) => part !== "." && part !== ".." && part.length > 0) &&
    typeof file.content === "string" && typeof file.mediaType === "string";
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = node("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadFile(file) {
  if (!state.plan || !state.plan.files.includes(file)) return;
  downloadBlob(new Blob([file.content], { type: file.mediaType }), file.name.replaceAll("/", "__"));
}

function downloadBundle() {
  if (!state.plan) return;
  try {
    state.archive ??= createHostingArchive(state.plan.files);
    downloadBlob(new Blob([state.archive], { type: "application/zip" }), `${state.plan.resourceName}.zip`);
  } catch {
    error("The complete bundle could not be downloaded safely. Generate a new review.");
  }
}

function renderPlan(plan, request) {
  if (plan?.providerId !== request.providerId || plan.component !== request.component ||
    plan.kind !== "manual" || plan.verification !== "not-live-tested" ||
    plan.resourceName !== `relmio-${request.component}-${request.deploymentId}` ||
    !Array.isArray(plan.files) || plan.files.length === 0 || !plan.files.every(validFile) ||
    !plan.files.some((file) => file.name === "INSTRUCTIONS.md") ||
    !Array.isArray(plan.steps) || !Array.isArray(plan.requirements) ||
    !Array.isArray(plan.limitations) || !Array.isArray(plan.settings) ||
    !plan.connection || typeof plan.connection !== "object") {
    throw new Error("The returned review is incomplete.");
  }
  state.plan = plan;
  el("hosting-review-details").open = false;
  el("hosting-reviewed-on").textContent = `Catalog reviewed ${plan.reviewedOn}. Live deployment: NOT-RUN.`;
  const provider = activeProvider();
  appendFacts(el("hosting-review-facts"), [
    ["Provider", provider.tested ? provider.label : [provider.label, " ", experimentalBadge()]], ["Resource name", plan.resourceName],
    ["Verification", "Not live tested"], ["Files", `${plan.files.length} individually downloadable files`],
  ]);
  appendList("hosting-requirements", plan.requirements);
  appendList("hosting-limitations", plan.limitations);
  appendList("hosting-steps", plan.steps);
  appendFacts(el("hosting-settings"), plan.settings.map((setting) => [setting.name, String(setting.value)]));
  el("hosting-connection").textContent = JSON.stringify(plan.connection, null, 2);
  renderSources(el("hosting-plan-sources"), plan.sources ?? []);
  const cards = plan.files.map((file) => {
    const card = node("article", undefined, "hosting-file");
    const header = node("div", undefined, "hosting-file__header");
    const button = node("button", `Download ${file.name}`, "rm-button rm-button--sm");
    button.type = "button";
    button.addEventListener("click", () => downloadFile(file));
    header.append(node("h4", file.name, "hosting-file__name"), button);
    card.append(header, node("pre", file.content, "hosting-code"));
    return card;
  });
  el("hosting-files").replaceChildren(...cards);
  showView("review");
}

el("hosting-provider").addEventListener("change", renderProvider);
el("hosting-component").addEventListener("change", renderComponent);
el("hosting-model").addEventListener("change", invalidate);
el("hosting-inputs").addEventListener("input", invalidate);
el("hosting-inputs").addEventListener("change", invalidate);

el("hosting-continue").addEventListener("click", () => {
  if (activeProfile()) showView("details");
});
el("hosting-details-back").addEventListener("click", () => { invalidate(); showView("choose"); });
el("hosting-review-back").addEventListener("click", () => showView("details"));
el("hosting-download-bundle").addEventListener("click", downloadBundle);
el("hosting-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const profile = activeProfile();
  if (!token || !profile || state.requestPending || !el("hosting-form").reportValidity()) return;
  invalidate();
  const generation = state.generation;
  const request = {
    providerId: profile.providerId,
    component: profile.component,
    deploymentId: randomDeploymentId(),
    ...(profile.component === "model" ? { modelId: el("hosting-model").value } : {}),
    inputs: planInputs(profile),
  };
  state.requestPending = true;
  el("hosting-generate").disabled = true;
  el("hosting-status").textContent = "Preparing your plan locally. No server or provider is contacted…";
  try {
    const response = await fetch("/api/hosting/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Token": token },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error("The provider plan was rejected. Check the selected fields and try again.");
    const plan = await response.json();
    if (generation !== state.generation) return;
    renderPlan(plan, request);
    el("hosting-status").textContent = "Plan ready. No server or provider was contacted.";
  } catch (failure) {
    if (generation === state.generation) error(failure.message);
  } finally {
    if (generation === state.generation) {
      state.requestPending = false;
      el("hosting-generate").disabled = !activeProfile();
    }
  }
});

async function loadCatalog() {
  if (!token) {
    el("hosting-status").textContent = "Open this page from the current Relmio session.";
    return;
  }
  try {
    const response = await fetch("/api/hosting/providers", { headers: { "X-Setup-Token": token } });
    if (!response.ok) throw new Error("The hosting catalog could not be loaded in this session.");
    const catalog = await response.json();
    if (!Array.isArray(catalog.providers) || !Array.isArray(catalog.profiles) || !Array.isArray(catalog.models)) {
      throw new Error("The hosting catalog is unavailable.");
    }
    state.providers = catalog.providers;
    state.profiles = catalog.profiles;
    state.models = catalog.models;
    el("hosting-provider").replaceChildren(option("", "Choose hosting"),
      ...Array.from(providersByKind(), ([kind, providers]) => {
        const group = node("optgroup");
        group.label = KIND_LABELS[kind] ?? kind;
        group.append(...providers.map((provider) => option(provider.id, provider.label)));
        return group;
      }));
    el("hosting-provider").disabled = false;
    renderMatrix();
    el("hosting-status").textContent = "Choose hosting and what to set up.";
  } catch {
    el("hosting-status").textContent = "Catalog unavailable; no plan can be generated.";
    error("The authenticated hosting catalog could not be loaded. Reopen this page from Relmio.");
  }
}

loadCatalog();

initWizardTopbar({
  session: token,
  isBusy: () => state.requestPending,
  loadProjectMeta: token
    ? async () => {
      const response = await fetch("/api/local/project-meta", { headers: { "X-Setup-Token": token } });
      if (!response.ok) throw new Error("Project details are unavailable.");
      return response.json();
    }
    : undefined,
});
