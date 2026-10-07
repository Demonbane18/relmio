const RECOVERY = new Set(["none", "retry-later", "reauthorize", "enable-plan", "manage-usage",
  "fix-request", "fix-configuration", "review-again", "resolve-handoff"]);

export function siwcErrorFromResponse(result, status) {
  const error = new Error(typeof result?.error === "string" ? result.error : "The request did not complete.");
  error.status = Number.isInteger(result?.status) ? result.status
    : Number.isInteger(result?.upstreamStatus) ? result.upstreamStatus : status;
  error.recovery = RECOVERY.has(result?.recovery) ? result.recovery : "none";
  for (const key of ["code", "param", "requestId"]) {
    if (typeof result?.[key] === "string" && result[key].length <= 128) error[key] = result[key];
  }
  if (typeof result?.registrationId === "string" &&
      /^[A-Za-z0-9_-]{8,128}$/u.test(result.registrationId)) error.registrationId = result.registrationId;
  if (result?.upstream && typeof result.upstream === "object") error.upstream = result.upstream;
  return error;
}

export function siwcErrorText(error) {
  const detail = error?.upstream?.body?.detail ?? error?.upstream?.body?.error?.message;
  const text = typeof detail === "string" && detail.length <= 240 ? detail : error?.message ?? "The request did not complete.";
  const fields = [error?.code && `Code: ${error.code}`, error?.param && `Field: ${error.param}`,
    error?.requestId && `Request ID: ${error.requestId}`].filter(Boolean);
  return fields.length ? `${text} ${fields.join(". ")}.` : text;
}

const USAGE_URL = "https://chatgpt.com/settings/usage";

export function accountUiState(account) {
  if (!account) return "new";
  if (account.ownership === "handoff-pending") return "handoff-pending";
  if (account.ownership === "transferred") return "transferred";
  if (account.session === "reauthorize") return "reauthorize";
  if (account.session !== "connected") return "signed-out";
  if (account.hostReady === false) return "host-unavailable";
  if (account.planPermission !== "granted") return "identity-only";
  return account.planEnabled ? "plan-active" : "plan-paused";
}

export function normalizeSiwcAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.registrationId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.registrationId) ||
      typeof value.label !== "string" || value.label.length > 160 ||
      (value.email !== undefined && (typeof value.email !== "string" || value.email.length > 254)) ||
      value.identity !== "verified" ||
      !["signed-out", "connected", "reauthorize"].includes(value.session) ||
      !["granted", "not-granted"].includes(value.planPermission) ||
      typeof value.planEnabled !== "boolean" ||
      !["owned", "handoff-pending", "transferred"].includes(value.ownership) ||
      typeof value.generation !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.generation) ||
      typeof value.ownerHostId !== "string" || !/^urn:uuid:[a-f0-9-]{36}$/iu.test(value.ownerHostId) ||
      typeof value.ownerRuntimeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.ownerRuntimeId) ||
      typeof value.needsPlanWelcome !== "boolean" ||
      (value.hostReady !== undefined && typeof value.hostReady !== "boolean")) {
    throw new Error("The ChatGPT account status is invalid.");
  }
  return {
    registrationId: value.registrationId, label: value.label,
    ...(value.email !== undefined ? { email: value.email } : {}),
    identity: "verified", session: value.session, planPermission: value.planPermission,
    planEnabled: value.planEnabled, ownership: value.ownership, generation: value.generation,
    ownerHostId: value.ownerHostId, ownerRuntimeId: value.ownerRuntimeId,
    needsPlanWelcome: value.needsPlanWelcome,
    ...(value.hostReady !== undefined ? { hostReady: value.hostReady } : {}),
  };
}

export function createSiwcControls({ root, api, onChange, onLogin, onError }) {
  const field = (name) => root.querySelector(`[data-siwc="${name}"]`);
  const picker = field("account");
  const status = field("status");
  const dialog = field("welcome");
  let accounts = [];
  let pendingRegistrations = [];
  let selectedId = null;
  let models = [];
  let catalogGeneration = null;
  let loadVersion = 0;
  let loaded = false;
  let busy = false;
  let previewMode = false;
  let notice = "";
  let previewFixture = null;
  let welcomeDue = false;
  let welcomeTrigger = null;

  function selected() {
    return accounts.find((account) => account.registrationId === selectedId) ?? null;
  }

  function display(account) {
    return `${account.label}${account.email ? ` (${account.email})` : ""} · ${account.registrationId.slice(-8)}`;
  }

  function welcomePending() {
    const account = selected();
    return accountUiState(account) === "plan-active" && account.needsPlanWelcome === true;
  }

  function usageLimited() {
    return previewFixture === "usage-limit" && ["plan-active", "plan-paused"].includes(accountUiState(selected()));
  }

  function usable(control) {
    return Boolean(control) && root.contains(control) && !control.disabled && control.checkVisibility?.() !== false;
  }

  function render() {
    const account = selected();
    const mode = accountUiState(account);
    const limited = usageLimited();
    const welcome = welcomePending();
    picker.replaceChildren();
    if (!accounts.length) {
      picker.add(new Option("No saved ChatGPT accounts", ""));
    } else {
      picker.add(new Option("Choose an account", ""));
      for (const item of accounts) {
        const option = new Option(display(item), item.registrationId);
        option.disabled = item.ownership !== "owned" || item.hostReady === false;
        picker.add(option);
      }
    }
    picker.value = selectedId ?? "";
    picker.disabled = busy || previewMode || accounts.length === 0;
    const pending = field("pending");
    pending.replaceChildren();
    for (const item of pendingRegistrations) pending.add(new Option(
      `${item.label} · ${item.registrationId.slice(-8)}`, item.registrationId,
    ));
    field("pending-row").hidden = pendingRegistrations.length === 0;
    pending.disabled = busy || previewMode;
    field("finish").disabled = busy || previewMode;
    // The status and owner lines describe the selected account; this list names the others.
    const transferred = field("transferred");
    const inactiveOwners = accounts.filter((item) => item.ownership !== "owned" && item.registrationId !== selectedId);
    transferred.replaceChildren(...inactiveOwners.map((item) => {
      const listItem = document.createElement("li");
      listItem.textContent = `${display(item)}: ${item.ownership === "transferred"
        ? `managed by ${item.ownerRuntimeId}` : "transfer pending, plan requests frozen"}.`;
      return listItem;
    }));
    transferred.hidden = inactiveOwners.length === 0;
    status.textContent = [
      limited ? "ChatGPT usage limit reached. Plan requests are paused. Manage usage in ChatGPT; Relmio does not switch accounts or billing."
        : welcome ? "ChatGPT plan use is granted. Review the plan notice before using it."
          : {
            new: "Continue with ChatGPT to connect an account. A fresh Relmio sign-in is required; old Codex credentials are not imported.",
            "signed-out": "Signed out. The account label remains here; sign in again to reconnect.",
            reauthorize: "This account needs a fresh ChatGPT sign-in before it can be used.",
            "identity-only": "Connected for identity. ChatGPT plan use has not been granted.",
            "plan-paused": "Connected. ChatGPT plan permission is granted, but plan use is paused in Relmio.",
            "plan-active": "Model access and each request still depend on this account and its limits.",
            "handoff-pending": "Transfer is unresolved. Plan requests are frozen until ownership is checked at the destination.",
            transferred: "This account was transferred to its installation. Manage its plan and sign-out from the installed target.",
            "host-unavailable": "This registration belongs to another host or runtime. Start a fresh Relmio sign-in here.",
          }[mode],
      previewFixture === "staged" && "Staged installation: build interrupted. Review a resume before another write.",
      notice,
    ].filter(Boolean).join(" ");
    field("return").hidden = !account || mode === "transferred" || mode === "handoff-pending";
    field("grant").hidden = !["identity-only"].includes(mode);
    field("resume").hidden = mode !== "plan-paused";
    field("pause").hidden = mode !== "plan-active" || limited;
    field("logout").hidden = !["identity-only", "plan-paused", "plan-active", "reauthorize"].includes(mode);
    for (const name of ["new", "return", "grant", "resume", "pause", "logout"]) {
      field(name).disabled = busy || previewMode;
    }
    field("welcome-open").hidden = !welcome || dialog.open;
    field("welcome-open").disabled = busy;
    field("plan-badge").hidden = mode !== "plan-active" || welcome || limited;
    const usage = field("usage");
    usage.href = USAGE_URL;
    usage.hidden = !["plan-active", "plan-paused"].includes(mode);
    // A usage limit makes Manage usage the primary recovery.
    usage.className = limited ? "rm-button rm-button--primary" : "rm-link rm-link--standalone";
    field("owner").textContent = mode === "transferred" || mode === "handoff-pending"
      ? `Owner: ${account.ownerRuntimeId ?? "destination not confirmed"}` : "";
  }

  // A modal opened in a hidden view is an invisible dialog that makes the page inert, and an
  // operation lock disables its buttons, so a due welcome waits until both clear.
  function showWelcome(trigger = null) {
    welcomeDue = welcomePending() && !dialog.open;
    if (!welcomeDue || !root.checkVisibility?.() || document.body?.dataset.operationBusy === "true") return;
    welcomeDue = false;
    welcomeTrigger = trigger;
    dialog.showModal();
    render();
    field("welcome-accept").focus();
  }

  // Operation locks restore the control states captured before the operation started, which
  // undoes render() for loads that ran inside it. Draw again once the page lock lifts.
  if (typeof MutationObserver !== "undefined" && document.body) {
    new MutationObserver(() => {
      if (!loaded || document.body.dataset.operationBusy !== "false") return;
      render();
      if (welcomeDue) showWelcome();
    }).observe(document.body, { attributes: true, attributeFilter: ["data-operation-busy"] });
  }

  async function load({ welcome = true } = {}) {
    const version = ++loadVersion;
    const result = await api("/api/siwc/accounts");
    if (version !== loadVersion) return selected();
    if (!Array.isArray(result.accounts) || !Array.isArray(result.pendingRegistrations)) {
      throw new Error("The ChatGPT account list could not be verified.");
    }
    const previous = selected();
    accounts = result.accounts.map(normalizeSiwcAccount);
    pendingRegistrations = result.pendingRegistrations.map((item) => {
      if (!item || typeof item.registrationId !== "string" ||
          !/^[A-Za-z0-9_-]{8,128}$/u.test(item.registrationId) ||
          typeof item.label !== "string" || item.label.length > 160) {
        throw new Error("The unfinished ChatGPT sign-in could not be verified.");
      }
      return { registrationId: item.registrationId, label: item.label };
    });
    previewMode = result.previewMode === true;
    previewFixture = result.previewFixture ?? null;
    selectedId = accounts.some((account) => account.registrationId === result.selectedRegistrationId)
      ? result.selectedRegistrationId : null;
    loaded = true;
    if (previous?.registrationId !== selectedId || previous?.generation !== selected()?.generation) {
      models = [];
      catalogGeneration = null;
      onChange?.(selected());
    }
    render();
    if (welcome) showWelcome();
    else welcomeDue = false;
    return selected();
  }

  async function change(action) {
    if (busy) return;
    const trigger = document.activeElement;
    busy = true;
    render();
    try {
      await action();
      await load();
    } catch (error) {
      onError?.(error);
      await load({ welcome: false }).catch(onError);
    } finally {
      busy = false;
      render();
      // The trigger may now be hidden (Sign out, Pause) or was disabled while busy.
      const active = document.activeElement;
      if (!active || active === document.body || (root.contains(active) && !usable(active))) {
        (usable(trigger) ? trigger : field("state")).focus();
      }
    }
  }

  picker.addEventListener("change", () => change(async () => {
    if (!accounts.some((account) => account.registrationId === picker.value &&
        account.ownership === "owned" && account.hostReady !== false)) {
      throw new Error("Choose an account owned by this computer.");
    }
    await api("/api/siwc/select", { method: "POST", body: { registrationId: picker.value } });
  }));
  field("new").addEventListener("click", () => onLogin({ purpose: "sign-in" }));
  field("finish").addEventListener("click", () => {
    const registrationId = field("pending").value;
    if (pendingRegistrations.some((item) => item.registrationId === registrationId)) {
      onLogin({ purpose: "sign-in", registrationId });
    }
  });
  field("return").addEventListener("click", () => {
    const account = selected();
    if (account) onLogin({ purpose: "sign-in", registrationId: account.registrationId });
  });
  field("grant").addEventListener("click", () => {
    const account = selected();
    if (account) onLogin({ purpose: "enable-plan", registrationId: account.registrationId });
  });
  field("resume").addEventListener("click", () => change(async () => {
    const account = selected();
    await api("/api/siwc/plan", { method: "POST", body: {
      registrationId: account.registrationId, enabled: true, expectedGeneration: account.generation,
    } });
  }));
  field("pause").addEventListener("click", () => change(async () => {
    const account = selected();
    await api("/api/siwc/plan", { method: "POST", body: {
      registrationId: account.registrationId, enabled: false, expectedGeneration: account.generation,
    } });
  }));
  field("logout").addEventListener("click", () => change(async () => {
    const account = selected();
    const result = await api("/api/siwc/logout", { method: "POST", body: {
      registrationId: account.registrationId, expectedGeneration: account.generation,
    } });
    notice = result.revocation === "unconfirmed"
      ? "Local tokens cleared. Remote revocation was not confirmed. Disconnect Relmio in ChatGPT settings."
      : "Provider revocation finished where applicable. Old Codex data is separate.";
  }));
  field("welcome-open").addEventListener("click", (event) => showWelcome(event.currentTarget));
  field("welcome-accept").addEventListener("click", () => change(async () => {
    const account = selected();
    await api("/api/siwc/ack", { method: "POST", body: {
      registrationId: account.registrationId, expectedGeneration: account.generation,
    } });
    dialog.close();
  }));
  // Escape closes without an acknowledgment: the plan stays unconfirmed and Review plan notice
  // reopens it. Focus returns to the control that opened it, or to the account state.
  dialog.addEventListener("close", () => {
    render();
    (usable(welcomeTrigger) ? welcomeTrigger : field("state")).focus();
    welcomeTrigger = null;
  });

  return {
    load, selected, showWelcome, isPreview: () => previewMode, isUsageLimited: usageLimited,
    async authorized({ purpose } = {}) {
      const account = await load({ welcome: false });
      if (purpose === "enable-plan" && account?.planPermission === "granted" && !account.planEnabled) {
        await api("/api/siwc/plan", { method: "POST", body: {
          registrationId: account.registrationId, enabled: true, expectedGeneration: account.generation,
        } });
      }
      return load();
    },
    async catalog() {
      const account = selected();
      if (accountUiState(account) !== "plan-active" || account.needsPlanWelcome) {
        models = [];
        catalogGeneration = null;
        return [];
      }
      const id = account.registrationId;
      const result = await api("/api/siwc/models");
      if (selected()?.registrationId !== id || result.account?.registrationId !== id ||
          !Array.isArray(result.models)) throw new Error("The ChatGPT account changed during model discovery.");
      models = result.models;
      catalogGeneration = result.account.generation;
      return [...models];
    },
    catalogIsCurrent() { return selected()?.generation === catalogGeneration; },
    clear() { ++loadVersion; models = []; catalogGeneration = null; },
  };
}

export function createSiwcRecovery({ root, api, vps = false, getTarget, onReview, onResult, onError }) {
  const node = (tag, text, className) => {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const details = node("details", "", "rm-disclosure");
  details.append(node("summary", "Recover a transfer or staged installation"));
  const body = node("div", "", "rm-disclosure__body");
  const label = node("label", "Recovery account", "rm-field");
  const account = node("select", "", "rm-select");
  label.append(account);
  const targetLabel = node("label", "Installation", "rm-field");
  const target = node("select", "", "rm-select");
  for (const [value, text] of [["codex-chatgpt", "Codex App Server"],
    ["codex-chat", "Codex Chat Adapter"], ["n8n-openai-oauth", "n8n ChatGPT sidecar"]]) {
    const option = node("option", text); option.value = value; target.append(option);
  }
  targetLabel.append(target);
  targetLabel.hidden = vps;
  const status = node("p", "Review is read-only. Confirm separately before recovery writes.", "rm-small");
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.tabIndex = -1;
  const check = node("button", "Review pending transfer", "rm-button rm-button--sm");
  const resume = node("button", "Review staged resume", "rm-button rm-button--sm");
  const confirmLabel = node("label", "", "rm-check");
  const confirm = node("input"); confirm.type = "checkbox";
  confirmLabel.append(confirm, node("span", "I approve checking this reviewed destination and finishing its transfer acknowledgment. No credential export is repeated."));
  confirmLabel.hidden = true;
  const apply = node("button", "Reconcile reviewed transfer", "rm-button rm-button--primary");
  for (const button of [check, resume, apply]) button.type = "button";
  apply.hidden = true; apply.disabled = true;
  body.append(label, targetLabel, status, check, resume, confirmLabel, apply);
  details.append(body); root.append(details);
  let reviewId = null;
  let busy = false;
  let preview = false;
  function clear() {
    reviewId = null; confirm.checked = false; confirmLabel.hidden = true; apply.hidden = true; apply.disabled = true;
  }
  async function load({ target: selectedTarget, registrationId } = {}) {
    clear();
    const result = await api("/api/siwc/accounts");
    preview = result.previewMode === true;
    account.replaceChildren();
    for (const value of result.accounts.map(normalizeSiwcAccount)) {
      const ownership = { owned: "owned here", "handoff-pending": "transfer pending", transferred: "transferred" }[value.ownership];
      const option = node("option", `${value.label} · ${value.registrationId.slice(-8)} (${ownership})`);
      option.value = value.registrationId; account.append(option);
    }
    if (selectedTarget) target.value = selectedTarget;
    if (registrationId) account.value = registrationId;
    check.disabled = resume.disabled = preview || !account.value;
    if (result.previewFixture === "staged") status.textContent = "Staged installation. Files remain owned; resume needs a fresh read-only review and final approval.";
    if (result.previewFixture === "handoff-pending") status.textContent = "Transfer acknowledgment is pending. Requests stay frozen; reconciliation reads the destination's original receipt.";
  }
  details.addEventListener("toggle", () => { if (details.open) void load().catch(onError); });
  account.addEventListener("change", clear); target.addEventListener("change", clear);
  confirm.addEventListener("change", () => { apply.disabled = !confirm.checked || !reviewId || busy; });
  async function perform(action) {
    if (busy || preview) return;
    busy = true;
    check.disabled = resume.disabled = apply.disabled = true;
    try {
      if (action !== "apply") {
        clear();
        const result = await api(`${vps ? "/api/siwc/vps" : "/api/local/siwc"}/recovery/review`, {
          method: "POST", body: { ...(vps ? getTarget() : { target: target.value,
            ...getTarget?.({ target: target.value, action }) }),
            registrationId: account.value, action },
        });
        if (action === "resume") {
          onReview(result);
        } else {
          if (typeof result.reviewId !== "string") throw new Error("Transfer review was not confirmed.");
          reviewId = result.reviewId;
          const ids = result.destination;
          status.textContent = `Reviewed ${result.account.label} at ${vps
            ? `n8n ${ids.n8nContainerId.slice(0, 12)}, network ${ids.networkId.slice(0, 12)}`
            : target.options[target.selectedIndex].textContent}. Confirm to reconcile its acknowledgment.`;
          confirmLabel.hidden = apply.hidden = false; confirm.focus();
        }
      } else {
        if (!confirm.checked || !reviewId) throw new Error("Review and confirm this transfer first.");
        const id = reviewId; clear();
        const result = await api(`${vps ? "/api/siwc/vps" : "/api/local/siwc"}/recovery/reconcile`, {
          method: "POST", body: { reviewId: id, confirmed: true },
        });
        status.textContent = result.outcome === "finished"
          ? "Original receipt confirmed. The destination owns this registration. Review its staged resume if installation is incomplete."
          : "Destination did not accept this transfer. The old session stays frozen. Start a fresh sign-in before reviewing recovery.";
        status.focus(); await onResult?.(result);
      }
    } catch (error) {
      clear(); onError(error);
    } finally {
      busy = false;
      check.disabled = resume.disabled = preview || !account.value;
      apply.disabled = !confirm.checked || !reviewId;
    }
  }
  check.addEventListener("click", () => { void perform("reconcile"); });
  resume.addEventListener("click", () => { void perform("resume"); });
  apply.addEventListener("click", () => { void perform("apply"); });
  return { clear, load };
}
