import { createHostingArchive } from "./hosting-archive.js";
import { bindWizardNavigation, readWizardSession } from "./session.js";

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
const FILE_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.dockerignore)(?:\/(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.dockerignore))*$/u;
const state = { providers: [], profiles: [], models: [], generation: 0, plan: null, archive: null, requestPending: false };

bindWizardNavigation(el("back-link"), "/", token);

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
  el("hosting-files").replaceChildren();
  el("hosting-generate").disabled = !activeProfile();
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

function renderMatrix() {
  const rows = state.providers.map((provider) => {
    const row = node("tr");
    row.dataset.selected = String(provider.id === el("hosting-provider").value);
    const heading = node("th", provider.label);
    heading.scope = "row";
    row.append(heading);
    for (const component of Object.keys(COMPONENTS)) {
      const capability = provider.components?.[component];
      const cell = node("td", capability?.mode ?? "unavailable");
      cell.dataset.mode = capability?.mode ?? "unavailable";
      cell.title = capability?.note ?? "No native route";
      row.append(cell);
    }
    return row;
  });
  el("hosting-matrix").replaceChildren(...rows);
}

function renderSources(target, sources) {
  const links = sources.filter((source) => {
    try { return new URL(source.url).protocol === "https:"; } catch { return false; }
  }).map((source) => {
    const link = node("a", source.label);
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
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
  el("hosting-capability").textContent = capability
    ? `${capability.mode.toUpperCase()}: ${capability.note}`
    : "Choose what to set up to see what's available.";
  const route = provider && MANAGED_ROUTES[provider.kind]?.[component];
  const oldLink = el("hosting-managed-link");
  const managedLink = oldLink.cloneNode(false);
  oldLink.replaceWith(managedLink);
  managedLink.hidden = !(capability?.mode === "managed" && route);
  if (!managedLink.hidden) {
    bindWizardNavigation(managedLink, route, token);
    managedLink.textContent = "Open managed setup";
  }
  el("hosting-model-wrap").hidden = !(profile && component === "model");
  el("hosting-model").disabled = el("hosting-model-wrap").hidden;
  el("hosting-model").required = !el("hosting-model-wrap").hidden;
  el("hosting-model").replaceChildren(
    option("", "Choose an approved model"),
    ...state.models.map((model) => option(model.id, `${model.label} · ${model.quantization}`)),
  );
  el("hosting-inputs").replaceChildren(...(profile?.fields ?? []).map(renderField));
  el("hosting-limits").textContent = profile
    ? "These files are not live tested. Check provider access, private routing, resources, storage, and your existing n8n connection before using them."
    : capability?.mode === "managed"
      ? provider.kind === "managed-vm"
        ? "Open setup to verify the server fingerprint (its identity) before connecting, then confirm the exact plan before any remote writes."
        : "Open local setup to review the plan and confirm before any changes."
      : capability
        ? "No complete manual plan is available for this route."
        : "";
  el("hosting-generate").disabled = !profile;
}

function renderField(field) {
  const label = node("label", undefined, "field");
  label.append(node("span", field.label));
  const input = document.createElement(field.type === "select" ? "select" : "input");
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
  label.append(input);
  if (field.description) label.append(node("small", field.description));
  return label;
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
  target.replaceChildren(...entries.flatMap(([name, value]) => [node("dt", name), node("dd", value)]));
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
  el("hosting-summary").textContent = `${activeProvider().label} · ${COMPONENTS[request.component]} · ${plan.resourceName} · reviewed ${plan.reviewedOn}. Live deployment: NOT-RUN.`;
  appendFacts(el("hosting-review-facts"), [
    ["Provider", activeProvider().label], ["Resource name", plan.resourceName],
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
    card.append(node("h4", file.name));
    const button = node("button", `Download ${file.name}`, "button secondary");
    button.type = "button";
    button.addEventListener("click", () => downloadFile(file));
    card.append(button, node("pre", file.content, "hosting-code"));
    return card;
  });
  el("hosting-files").replaceChildren(...cards);
  el("hosting-review").hidden = false;
  el("review-title").focus();
}

el("hosting-provider").addEventListener("change", renderProvider);
el("hosting-component").addEventListener("change", renderComponent);
el("hosting-model").addEventListener("change", invalidate);
el("hosting-inputs").addEventListener("input", invalidate);
el("hosting-inputs").addEventListener("change", invalidate);

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
    el("hosting-status").textContent = "Plan ready. Review it before downloading; no server or provider was contacted.";
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
      ...state.providers.map((provider) => option(provider.id, provider.label)));
    el("hosting-provider").disabled = false;
    renderMatrix();
    el("hosting-status").textContent = "Choose hosting and what to set up.";
  } catch {
    el("hosting-status").textContent = "Catalog unavailable; no plan can be generated.";
    error("The authenticated hosting catalog could not be loaded. Reopen this page from Relmio.");
  }
}

loadCatalog();
