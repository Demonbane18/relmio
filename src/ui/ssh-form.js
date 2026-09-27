const element = (id) => document.getElementById(id);

async function sshRead(token, path) {
  const response = await fetch(path, { headers: { "X-Setup-Token": token }, credentials: "omit", mode: "same-origin", redirect: "error", cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The SSH session could not be inspected.");
  return result;
}

export function sameSshIdentity(left, right) {
  return Boolean(left && right && ["host", "port", "fingerprint", "username", "authentication", "privilege", "loginUid", "effectiveUid", "scope", "generation"].every((key) => left[key] === right[key]));
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
  const identity = validateSshIdentity(await sshRead(token, "/api/ssh/connection"));
  if (!allowModelOnly && identity.scope !== "vps") {
    throw new Error("This connection is local-model-only (sudo -n). Use the Local model page, or disconnect and reconnect with a UID 0 account for this VPS flow.");
  }
  return identity;
}

export function createCredentialSshGuard({ token, onMismatch }) {
  let adopted = null;
  let initialAdoptionAvailable = true;
  const isRemote = path => ["/api/discover", "/api/networks", "/api/plan", "/api/install"].includes(path) ||
    path.startsWith("/api/assistant/") || path.startsWith("/api/vps/supergrok/");
  function adopt(identity) {
    validateSshIdentity(identity);
    if (identity.scope !== "vps") throw new Error("This connection is local-model-only. Reconnect with a UID 0 account for this VPS flow.");
    adopted = Object.freeze({ ...identity });
    initialAdoptionAvailable = false;
    const summary = `${identity.username}@${identity.host}:${identity.port} · ${identity.authentication} · ${identity.privilege} · UID ${identity.loginUid} → ${identity.effectiveUid} · ${identity.fingerprint}`;
    element("ssh-session").textContent = summary;
    element("ssh-review-identity").textContent = summary;
    element("ssh-disconnect").hidden = false;
  }
  function rejectIdentity(error) {
    initialAdoptionAvailable = false;
    error.sshIdentityUnverified = true;
    adopted = null;
    onMismatch();
    element("ssh-review-identity").textContent = "";
    element("ssh-session").textContent = error.message;
    element("ssh-disconnect").hidden = false;
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
    async adoptCurrent() {
      if (!initialAdoptionAvailable) return verify();
      initialAdoptionAvailable = false;
      try { adopt(await readSshIdentity(token)); } catch (error) { rejectIdentity(error); }
    },
    async before(path) { if (isRemote(path)) await verify(); },
    async after(path, result) {
      if (path === "/api/ssh/connect") adopt(result.identity);
      else if (path === "/api/disconnect") adopted = null;
      // These root installs intentionally retire their connection after completion.
      else if (path === "/api/install" || path === "/api/assistant/install") adopted = null;
      else if (isRemote(path)) await verify();
    },
  };
}

export function bindSshAuthentication({ token, trustId, onChange, allowSudo = false }) {
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
      if (!response.ok) throw new Error(result.error || "Disconnect failed.");
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
      element("ssh-session").textContent = `Connected as ${identity.username}@${identity.host}:${identity.port}, ${identity.authentication}, ${identity.privilege}, UID ${identity.loginUid} → ${identity.effectiveUid}. ${identity.scope === "local-model-only" ? "Model-only session; OAuth bridge, Assistant and SuperGrok require a root reconnect." : "Verified root VPS session."}`;
      element("ssh-disconnect").hidden = false;
    }).catch((error) => {
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
