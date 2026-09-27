import { timingSafeEqual } from "node:crypto";
import { posix as path } from "node:path";
import { stat as statPath } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import ssh2 from "ssh2";

import { INSTALL_ROOT } from "../domain/safety.js";
import {
  validateHostname,
  validatePort,
  validateUsername,
} from "../domain/validation.js";
import {
  ADMIN_PROBE, LOGIN_PROBE, MAX_UPLOAD_BYTES, administrativeCommand,
  parseAdministrativeProbe, parseLoginUid, modelUploadCommand, validateModelUpload,
} from "./ssh-administration.js";

const { Client } = ssh2;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const unknownRemoteOutcome = message => Object.assign(new Error(message), { remoteOutcomeUnknown: true });

function fingerprintsMatch(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function validateExpectedFingerprint(value) {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError("SSH host fingerprint is invalid.");
  }
  return value;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new TypeError("An SSH password or agent is required.");
  }
  return value;
}

function validateManagedPath(value) {
  if (typeof value !== "string") {
    throw new TypeError("Remote path is invalid.");
  }

  const normalized = path.normalize(value);
  if (
    normalized !== value ||
    !normalized.startsWith(`${INSTALL_ROOT}/`) ||
    normalized.includes("\0")
  ) {
    throw new TypeError("Remote path must stay inside the sidecar directory.");
  }
  return normalized;
}

export function formatSha256Fingerprint(hexDigest) {
  if (
    typeof hexDigest !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(hexDigest)
  ) {
    throw new TypeError("SSH fingerprint digest is invalid.");
  }

  const base64 = Buffer.from(hexDigest, "hex")
    .toString("base64")
    .replace(/=+$/u, "");
  return `SHA256:${base64}`;
}

const WINDOWS_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

function probeAgentPipe(address) {
  return new Promise(resolve => {
    const socket = connectSocket(address);
    let settled = false;
    const finish = available => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function resolveSshAgent({
  env = process.env, platform = process.platform,
  stat = statPath, probePipe = probeAgentPipe,
} = {}) {
  let agent = null;
  let transport = null;
  if (platform === "win32") {
    // ssh2's native OpenSSHAgent uses net.Socket for named pipes. Never select
    // Pageant/Cygwin implicitly or infer availability from an ssh.exe install.
    if (await probePipe(WINDOWS_AGENT_PIPE).catch(() => false)) {
      agent = WINDOWS_AGENT_PIPE;
      transport = "windows-openssh-pipe";
    }
  } else if (typeof env.SSH_AUTH_SOCK === "string" &&
      env.SSH_AUTH_SOCK.startsWith("/") && !/[\0\r\n]/u.test(env.SSH_AUTH_SOCK)) {
    const entry = await stat(env.SSH_AUTH_SOCK).catch(() => null);
    if (entry?.isSocket()) {
      agent = env.SSH_AUTH_SOCK;
      transport = "unix-socket";
    }
  }
  return { agent, capability: { agent: {
    status: agent ? "configured" : "unavailable", transport,
    verification: "untested",
  } } };
}

export async function getSshCapabilities(options) {
  return (await resolveSshAgent(options)).capability;
}

export function buildVerifiedConnectionConfig(options, { agent } = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("SSH connection options are invalid.");
  }
  const allowed = new Set(["host", "port", "username", "expectedFingerprint", "useAgent", "privilege", "password"]);
  if (Object.keys(options).some(key => !allowed.has(key)) ||
      typeof options.useAgent !== "boolean" ||
      !["root", "sudo-n"].includes(options.privilege)) {
    throw new TypeError("Choose an explicit SSH password or agent and privilege mode.");
  }
  const { host, port, username, expectedFingerprint, useAgent } = options;
  const fingerprint = validateExpectedFingerprint(expectedFingerprint);
  if (useAgent && Object.hasOwn(options, "password") ||
      !useAgent && agent !== undefined) {
    throw new TypeError("SSH password and agent authentication must be exclusive.");
  }
  const auth = useAgent
    ? typeof agent === "string" && agent.length > 0
      ? { agent }
      : null
    : { password: validatePassword(options.password) };
  if (!auth) throw new TypeError("No local SSH agent is configured. Load a key before starting Relmio.");
  return {
    host: validateHostname(host), port: validatePort(port),
    username: validateUsername(username), ...auth,
    hostHash: "sha256",
    hostVerifier(hexDigest) {
      try { return fingerprintsMatch(formatSha256Fingerprint(hexDigest), fingerprint); }
      catch { return false; }
    },
    // Restrict ssh2's authentication sequence, rather than relying only on
    // missing credential properties to suppress implicit authentication.
    authHandler: [useAgent ? "agent" : "password"],
    agentForward: false,
    readyTimeout: 15_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
    tryKeyboard: false,
  };
}

class SshConnection {
  #client;
  #engine;
  #privilege;

  constructor(client, privilege) {
    this.#client = client;
    this.#privilege = privilege;
    client.on("error", () => {});
  }

  async prepare(options, config, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        this.#attest(options, config),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("The read-only VPS administrative probes timed out. No remote files were written.")), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async #attest(options, config) {
    const loginUid = parseLoginUid(await this.#run(LOGIN_PROBE));
    if (options.privilege === "root" && loginUid !== 0) {
      throw new Error("Root administration requires an actual UID 0 login. Select passwordless sudo for the model-only flow.");
    }
    this.#engine = parseAdministrativeProbe(await this.#run(
      administrativeCommand(ADMIN_PROBE, this.#privilege),
    ));
    Object.defineProperties(this, {
      identity: { enumerable: true, value: Object.freeze({
        host: config.host, port: config.port, fingerprint: options.expectedFingerprint,
        username: config.username, authentication: options.useAgent ? "agent" : "password",
        privilege: options.privilege, loginUid, effectiveUid: 0,
      }) },
      scope: { enumerable: true, value: options.privilege === "root" ? "vps" : "local-model-only" },
    });
    return this;
  }

  exec(command, { input } = {}) {
    if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
      return Promise.reject(new TypeError("Remote command is invalid."));
    }
    if (input !== undefined && (this.#privilege === "sudo-n" ||
        typeof input !== "string" || Buffer.byteLength(input) > 64 * 1024)) {
      return Promise.reject(new TypeError("Remote command input is invalid. Sudo model-only commands do not accept stdin."));
    }
    return this.#run(administrativeCommand(command, this.#privilege, this.#engine), input);
  }

  #run(command, input) {
    return new Promise((resolve, reject) => {
      const started = (error, stream) => {
        if (error) {
          reject(new Error("The VPS refused to start a remote command."));
          return;
        }
        const stdout = [];
        const stderr = [];
        let byteCount = 0;
        let settled = false;
        const fail = message => {
          if (settled) return;
          settled = true;
          stream.destroy();
          reject(unknownRemoteOutcome(message));
        };
        const append = (target, chunk) => {
          if (settled) return;
          byteCount += Buffer.byteLength(chunk);
          if (byteCount > MAX_COMMAND_OUTPUT_BYTES) {
            fail("Remote command output exceeded the safety limit.");
            return;
          }
          target.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        };
        stream.on("data", chunk => append(stdout, chunk));
        stream.stderr.on("data", chunk => append(stderr, chunk));
        stream.once("error", () => fail("The SSH command stream failed."));
        stream.stderr.once("error", () => fail("The SSH command stream failed."));
        stream.once("close", code => {
          if (settled) return;
          settled = true;
          if (!Number.isInteger(code)) {
            reject(unknownRemoteOutcome("The SSH command closed without a verified exit status. Its remote outcome is unknown."));
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            code,
          });
        });
        // Keep each pending write bounded and honor ssh2 Channel backpressure.
        // Sending EOF also prevents stdin-reading commands hanging indefinitely.
        const data = input === undefined ? null : Buffer.isBuffer(input) ? input : Buffer.from(input);
        let offset = 0;
        const pump = () => {
          if (settled) return;
          try {
            while (data && offset < data.length) {
              const end = Math.min(offset + 16 * 1024, data.length);
              const chunk = data.subarray(offset, end);
              offset = end;
              if (!stream.write(chunk)) {
                stream.once("drain", pump);
                return;
              }
            }
            stream.end();
          } catch { fail("The SSH command stream failed."); }
        };
        pump();
      };
      try { this.#client.exec(command, started); }
      catch { reject(new Error("The VPS refused to start a remote command.")); }
    });
  }

  upload(remotePath, contents, mode = 0o600) {
    const safePath = validateManagedPath(remotePath);
    if (this.#privilege === "sudo-n") {
      const data = validateModelUpload(safePath, contents, mode);
      return this.#run(administrativeCommand(modelUploadCommand(safePath, data), this.#privilege, this.#engine), data)
        .then(result => {
          if (result.code !== 0) throw new Error("Upload rejected.");
        })
        .catch(error => {
          const failure = new Error("The public model upload failed its safety checks or was interrupted. A partial managed file may remain; inspect ownership before retrying.");
          if (error.remoteOutcomeUnknown === true) failure.remoteOutcomeUnknown = true;
          throw failure;
        });
    }
    if (![0o600, 0o644].includes(mode) ||
        typeof contents !== "string" && !Buffer.isBuffer(contents)) {
      throw new TypeError("Remote upload contents or mode are invalid.");
    }
    const size = Buffer.isBuffer(contents) ? contents.length : Buffer.byteLength(contents);
    if (size > MAX_UPLOAD_BYTES) throw new TypeError("Remote upload exceeded the safety limit.");
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    return new Promise((resolve, reject) => {
      let settled = false;
      let channel;
      let writeStarted = false;
      const finish = failed => {
        if (settled) return;
        settled = true;
        for (const event of ["error", "end", "close"]) this.#client.removeListener(event, interrupted);
        try { channel?.end(); } catch {}
        if (failed) {
          const message = "The SFTP upload failed or was interrupted. A partial managed file may remain.";
          reject(writeStarted ? unknownRemoteOutcome(message) : new Error(message));
        } else resolve();
      };
      const interrupted = () => finish(true);
      for (const event of ["error", "end", "close"]) this.#client.once(event, interrupted);
      const ready = (sftpError, sftp) => {
        channel = sftp;
        if (sftpError) { finish(true); return; }
        // Keep this channel's error listener until disposal: ssh2 can report a
        // late error after writeFile's callback or while pending CLOSE is lost.
        channel.on("error", interrupted);
        channel.once("end", interrupted);
        channel.once("close", interrupted);
        if (settled) { try { channel.end(); } catch {} return; }
        try {
          writeStarted = true;
          channel.writeFile(safePath, data, { mode, flag: "w" }, error => finish(Boolean(error)));
        } catch { finish(true); }
      };
      try { this.#client.sftp(ready); } catch { finish(true); }
    });
  }

  close() { this.#client.end(); }
}

export async function connectVerified(
  options,
  { createClient = () => new Client(), resolveAgent = resolveSshAgent, prepareTimeoutMs = 30_000 } = {},
) {
  if (!Number.isInteger(prepareTimeoutMs) || prepareTimeoutMs < 1 || prepareTimeoutMs > 30_000) {
    throw new TypeError("SSH administrative probe deadline is invalid.");
  }
  options = Object.freeze({ ...options });
  // Validate discriminants before even touching a local agent transport.
  const needsAgent = options?.useAgent === true;
  if (needsAgent) buildVerifiedConnectionConfig(options, { agent: "validation-only" });
  let agent;
  if (needsAgent) {
    try { agent = (await resolveAgent()).agent; }
    catch { throw new Error("The local SSH agent is unavailable."); }
  }
  const config = buildVerifiedConnectionConfig(options, { agent: agent ?? undefined });
  const client = createClient();
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new Error("SSH connection failed. Check the address, selected authentication, firewall, and confirmed fingerprint."));
    };
    client.once("ready", () => { if (!settled) { settled = true; resolve(); } });
    client.on("error", fail);
    client.once("close", fail);
    try { client.connect(config); } catch { fail(); }
  });
  const remote = new SshConnection(client, options.privilege);
  try { return await remote.prepare(options, config, prepareTimeoutMs); }
  catch (error) { remote.close(); throw error; }
}

export function scanHostFingerprint(
  { host, port },
  { createClient = () => new Client() } = {},
) {
  const safeHost = validateHostname(host);
  const safePort = validatePort(port);

  return new Promise((resolve, reject) => {
    const client = createClient();
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new Error("The VPS did not provide an SSH host key. Check its address, SSH port and firewall."));
    };
    client.on("error", fail);
    client.once("end", fail);
    client.once("close", fail);

    client.connect({
      host: safeHost,
      port: safePort,
      username: "fingerprint-scan",
      hostHash: "sha256",
      hostVerifier(hexDigest) {
        if (!settled) {
          settled = true;
          resolve(formatSha256Fingerprint(hexDigest));
          queueMicrotask(() => client.end());
        }
        return false;
      },
      readyTimeout: 10_000,
      tryKeyboard: false,
    });
  });
}
