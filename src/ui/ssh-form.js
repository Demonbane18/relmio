import { wizardApiError } from "./session.js";

const element = (id) => document.getElementById(id);

async function sshRead(token, path) {
  const response = await fetch(path, { headers: { "X-Setup-Token": token }, credentials: "omit", mode: "same-origin", redirect: "error", cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw wizardApiError(result, response.status, "The SSH session could not be inspected.");
  return result;
}

const HOST_REPORT_NOTE = "A pass only repeats what Docker reported. It does not prove that a later build will work.";
// Short names for the checks that can fail, shown in the closed row.
const HOST_REPORT_CHECKS = { login: "Sign-in", cpu: "CPU", network: "Network" };
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// The host report as plain text for one flow: a one-line label that counts the
// warnings and names each failed check, the facts Docker reported, and the rows
// that warn or fail for that flow, problems first. Rows for other flows and
// facts the probe did not learn are left out.
export function describeHostReport(report, flow) {
  if (!report || typeof report !== "object" || !Array.isArray(report.rows)) return null;
  const fact = (value) => (typeof value === "string" && value && value.length <= 80 ? value : null);
  const host = report.host ?? {};
  const facts = [fact(host.os), fact(host.arch),
    fact(host.dockerVersion) && `Docker ${host.dockerVersion}`,
    fact(host.composeVersion) && `Compose ${host.composeVersion}`].filter(Boolean);
  const rows = report.rows.filter((row) => ["warn", "fail"].includes(row?.level) &&
    typeof row.text === "string" && row.text && row.text.length <= 240 &&
    (!Array.isArray(row.flows) || row.flows.length === 0 || row.flows.includes(flow)))
    .sort((a, b) => Number(b.level === "fail") - Number(a.level === "fail"));
  const failed = [...new Set(rows.filter(({ level }) => level === "fail")
    .map(({ id }) => (Object.hasOwn(HOST_REPORT_CHECKS, id) ? HOST_REPORT_CHECKS[id] : "Server")))];
  const warnings = rows.filter(({ level }) => level === "warn").length;
  const counts = [failed.length && `${failed.join(" and ")} ${failed.length === 1 ? "problem" : "problems"}`,
    warnings && plural(warnings, "warning")].filter(Boolean).join(", ");
  return {
    label: `Server check: ${counts || "no warnings"}`,
    facts: `${facts.length ? facts.join(", ") : "Server facts are unavailable"}.`,
    issues: rows.map(({ level, text }) => ({ level, text })),
  };
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Shows the report in every <details data-host-report> on the page. One that
// starts hidden is a row of its own. One that starts visible is the step's own
// disclosure, which keeps its summary and text when there is no report. The
// summary carries the one-line label and the details go into a bounded region,
// so a report never opens by itself and costs at most one line while closed.
const hostReportBoxes = new WeakMap();
export function renderHostReport(report, flow) {
  const view = describeHostReport(report, flow);
  const key = JSON.stringify(view);
  for (const box of document.querySelectorAll("[data-host-report]")) {
    let home = hostReportBoxes.get(box);
    if (!home) {
      const summary = box.querySelector("summary");
      home = { summary, label: summary.textContent, own: box.hidden, region: null, key: undefined };
      hostReportBoxes.set(box, home);
    }
    if (home.key === key) continue;
    home.key = key;
    home.region?.remove();
    home.region = null;
    home.summary.textContent = view ? view.label : home.label;
    if (home.own) {
      box.hidden = !view;
      if (!view) box.open = false;
    }
    if (!view) continue;
    const region = make("div", "rm-disclosure__region");
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", "Server check details");
    region.setAttribute("tabindex", "0");
    region.append(make("p", "", view.facts));
    if (view.issues.length) {
      const list = make("ul", "rm-disclosure__list");
      list.append(...view.issues.map(({ level, text }) => make("li", "", `${level === "fail" ? "Problem" : "Warning"}: ${text}`)));
      region.append(list);
    }
    region.append(make("p", "", HOST_REPORT_NOTE));
    box.querySelector(".rm-disclosure__body").prepend(region);
    home.region = region;
  }
}

// Reads the report for the verified connection and shows it for one flow. The
// server answers from what the connection probe already learned, with no remote
// call; it adds the network row when the selected n8n container and network are
// sent. The report only informs, so a failed read hides it instead of raising
// an error.
let hostReportRead = 0;
export async function showHostReport(token, { flow, container, network }) {
  const read = ++hostReportRead;
  const query = container && network ? `?${new URLSearchParams({ container, network })}` : "";
  let report = null;
  try { report = await sshRead(token, `/api/ssh/host-report${query}`); } catch { /* Shown as no report. */ }
  if (read === hostReportRead) renderHostReport(report, flow);
}

export function clearHostReport() {
  hostReportRead++;
  renderHostReport(null);
}

export function sameSshIdentity(left, right) {
  return Boolean(left && right && ["host", "port", "fingerprint", "username", "authentication", "privilege", "loginUid", "effectiveUid", "scope", "generation"].every((key) => left[key] === right[key]));
}

// Marks a rejected field invalid and links the visible error to it, keeping any
// hint already in aria-describedby. clearFieldError undoes both on correction.
export function setFieldError(input, errorId) {
  input.setAttribute("aria-invalid", "true");
  const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean);
  if (!ids.includes(errorId)) input.setAttribute("aria-describedby", [...ids, errorId].join(" "));
}

export function clearFieldError(input, errorId) {
  input.removeAttribute("aria-invalid");
  const ids = (input.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter((id) => id && id !== errorId);
  if (ids.length) input.setAttribute("aria-describedby", ids.join(" "));
  else input.removeAttribute("aria-describedby");
}

const REJECTED_FIELDS = [["Hostname", "host"], ["Port", "port"], ["Username", "username"], ["Password", "password"]];

// The server names fields technically ("Hostname is invalid."). Marks the
// matching field invalid and returns the message using the field's visible
// label, for example "Server address is invalid.". Other messages pass through.
export function markRejectedField(text, find, errorId) {
  const match = REJECTED_FIELDS.find(([prefix]) => text.startsWith(`${prefix} is invalid.`));
  if (!match) return text;
  const input = find(match[1]);
  setFieldError(input, errorId);
  const label = input.closest?.(".rm-field")?.querySelector(".rm-field__label")?.textContent.trim();
  return label ? `${label}${text.slice(match[0].length)}` : text;
}

export function validateSshIdentity(identity) {
  if (!identity || typeof identity.host !== "string" || !identity.host ||
    !Number.isSafeInteger(identity.port) || identity.port < 1 || identity.port > 65535 ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(identity.fingerprint) ||
    typeof identity.username !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/iu.test(identity.username) ||
    !["agent", "password"].includes(identity.authentication) ||
    !["root", "sudo-n"].includes(identity.privilege) ||
    !Number.isSafeInteger(identity.loginUid) || identity.loginUid < 0 || identity.effectiveUid !== 0 ||
    !Number.isSafeInteger(identity.generation) || identity.generation < 1 ||
    identity.scope !== (identity.privilege === "root" ? "vps" : "local-model-only") ||
    (identity.privilege === "root" && identity.loginUid !== 0)) {
    throw new Error("The verified administrative SSH identity is unavailable. Disconnect and reconnect.");
  }
  return identity;
}

export async function readSshIdentity(token, { allowModelOnly = false } = {}) {
  const result = await sshRead(token, "/api/ssh/connection");
  if (result?.connected === false) throw new Error("Connect to the VPS first.");
  const identity = validateSshIdentity(result);
  if (!allowModelOnly && identity.scope !== "vps") {
    throw new Error("This connection is local-model-only (sudo -n). Use the Local model page, or disconnect and reconnect with a UID 0 account for this VPS flow.");
  }
  return identity;
}

// A review with its own host-key field keeps the server line short; other reviews
// show the fingerprint at the end of the server line.
function showReviewIdentity(server, fingerprint) {
  const fingerprintField = element("ssh-review-fingerprint");
  if (fingerprintField) fingerprintField.textContent = fingerprint;
  element("ssh-review-identity").textContent = fingerprintField || !server ? server : `${server} · ${fingerprint}`;
}

// `hostReport` returns the page's flow and current selection for the host
// report, as { flow, container, network }. Without it the guard leaves the
// report alone. Pages call refreshHostReport() after the selection changes.
export function createCredentialSshGuard({ token, onMismatch, onIdentityDecision = () => {}, hostReport = null }) {
  let adopted = null;
  let initialAdoptionAvailable = true;
  const isRemote = path => ["/api/discover", "/api/networks", "/api/plan", "/api/install"].includes(path) ||
    path.startsWith("/api/assistant/") || path.startsWith("/api/vps/supergrok/") || path.startsWith("/api/vps/claude/");
  function adopt(identity) {
    validateSshIdentity(identity);
    if (identity.scope !== "vps") throw new Error("This connection is local-model-only. Reconnect with a UID 0 account for this VPS flow.");
    adopted = Object.freeze({ ...identity });
    onIdentityDecision();
    initialAdoptionAvailable = false;
    const server = `${identity.username}@${identity.host}:${identity.port} · ${identity.authentication} · ${identity.privilege} · UID ${identity.loginUid} → ${identity.effectiveUid}`;
    element("ssh-session").textContent = `${server} · ${identity.fingerprint}`;
    showReviewIdentity(server, identity.fingerprint);
    element("ssh-disconnect").hidden = false;
    if (hostReport) void showHostReport(token, hostReport());
  }
  function rejectIdentity(error) {
    initialAdoptionAvailable = false;
    error.sshIdentityUnverified = true;
    adopted = null;
    onIdentityDecision();
    onMismatch();
    showReviewIdentity("", "");
    element("ssh-session").textContent = error.message;
    element("ssh-disconnect").hidden = error.message === "Connect to the VPS first.";
    if (hostReport) clearHostReport();
    throw error;
  }
  async function verify() {
    try {
      const current = await readSshIdentity(token);
      if (!adopted || !sameSshIdentity(adopted, current)) {
        throw new Error("The authenticated VPS changed. Disconnect and reconnect before discovering, reviewing or applying this action.");
      }
    } catch (error) {
      rejectIdentity(error);
    }
  }
  return {
    adoptedIdentity: () => adopted,
    async adoptCurrent() {
      if (!initialAdoptionAvailable) return verify();
      initialAdoptionAvailable = false;
      try { adopt(await readSshIdentity(token)); } catch (error) { rejectIdentity(error); }
    },
    async before(path) { if (isRemote(path)) await verify(); },
    async after(path, result) {
      if (path === "/api/ssh/connect") adopt(result.identity);
      else if (path === "/api/disconnect") {
        adopted = null;
        onIdentityDecision();
        showReviewIdentity("", "");
        element("ssh-session").textContent = "No authenticated VPS session.";
        if (hostReport) clearHostReport();
      }
      // A pending image sign-in keeps the verified SSH connection until polling finishes.
      else if (path === "/api/assistant/install" || (path === "/api/install" && result.images?.state !== "pending")) {
        adopted = null;
        onIdentityDecision();
      }
      else if (isRemote(path)) await verify();
    },
    refreshHostReport() { if (hostReport && adopted) void showHostReport(token, hostReport()); },
  };
}

export function bindSshAuthentication({ token, trustId, onChange, allowSudo = false, shouldApplyConnectionStatus = () => true }) {
  let locked = false;
  const useAgent = () => element("ssh-authentication").value === "agent";
  function sync(options = {}) {
    if (options.locked !== undefined) locked = options.locked;
    const trusted = options.trusted ?? element(trustId).checked;
    element("password").disabled = locked || !trusted || useAgent();
    element("password").required = !useAgent();
    element("ssh-authentication").disabled = locked;
    element("username").disabled = locked;
    if (allowSudo) element("ssh-privilege").disabled = locked;
    if (useAgent()) element("password").value = "";
  }
  for (const id of ["ssh-authentication", ...(allowSudo ? ["ssh-privilege"] : [])]) {
    element(id).addEventListener("change", () => { element("password").value = ""; onChange(); sync(); });
  }
  element("username").addEventListener("input", onChange);
  element("ssh-disconnect").addEventListener("click", async () => {
    element("ssh-disconnect").disabled = true;
    try {
      const response = await fetch("/api/disconnect", { method: "POST", headers: { "X-Setup-Token": token, "Content-Type": "application/json" }, body: "{}", credentials: "omit", mode: "same-origin", redirect: "error" });
      const result = await response.json();
      if (!response.ok) throw wizardApiError(result, response.status, "Disconnect failed.");
      window.location.reload();
    } catch (error) {
      element("ssh-session").textContent = error.message;
      element("ssh-disconnect").disabled = false;
    }
  });
  sync();
  if (token) {
    void sshRead(token, "/api/ssh/capabilities").then(({ agent }) => {
      element("ssh-agent-status").textContent = agent?.status === "configured"
        ? `Local agent configured (${agent.transport === "windows-openssh-pipe" ? "Windows OpenSSH pipe" : "Unix socket"}); keys and server authentication are untested.`
        : "No usable local SSH agent is configured for this Relmio process. Load your key locally and relaunch Relmio, or choose password authentication.";
    }).catch(() => { element("ssh-agent-status").textContent = "Local SSH agent capability could not be checked. Authentication is not verified."; });
    void readSshIdentity(token, { allowModelOnly: true }).then((identity) => {
      if (!shouldApplyConnectionStatus()) return;
      element("ssh-session").textContent = `Connected as ${identity.username}@${identity.host}:${identity.port}, ${identity.authentication}, ${identity.privilege}, UID ${identity.loginUid} → ${identity.effectiveUid}. ${identity.scope === "local-model-only" ? "Model-only session; OAuth bridge, Assistant, SuperGrok and Claude require a root reconnect." : "Verified root VPS session."}`;
      element("ssh-disconnect").hidden = false;
    }).catch((error) => {
      if (!shouldApplyConnectionStatus()) return;
      element("ssh-session").textContent = error.message === "Connect to the VPS first." ? "No authenticated VPS session." : error.message;
    });
  }
  return {
    sync,
    request(expectedFingerprint) {
      const agent = useAgent();
      const request = {
        host: element("host").value, port: Number(element("port").value), username: element("username").value,
        expectedFingerprint, useAgent: agent, privilege: allowSudo ? element("ssh-privilege").value : "root",
        ...(agent ? {} : { password: element("password").value }),
      };
      element("password").value = "";
      return request;
    },
  };
}
