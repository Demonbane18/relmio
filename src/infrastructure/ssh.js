import { randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { stat as statPath } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { posix as path } from "node:path";
import ssh2 from "ssh2";

import { INSTALL_ROOT } from "../domain/safety.js";
import {
  validateHostname,
  validatePort,
  validateUsername,
} from "../domain/validation.js";
import {
  ADMIN_PROBE, LOGIN_PROBE, MAX_UPLOAD_BYTES, administrativeCommand,
  parseAdministrativeProbe, parseLoginUid, modelUploadCommand, quoteShell, validateModelUpload,
} from "./ssh-administration.js";

const { Client } = ssh2;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const DEFAULT_COMMAND_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 5 * 60_000;
const MAX_DEADLINE_MS = 2 * 60 * 60_000;
const fileFailure = () => new Error("The managed deployment file is unsafe or its ownership cannot be verified.");
function deadline(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_DEADLINE_MS) {
    throw new TypeError("SSH operation deadline is invalid.");
  }
  return value;
}

function checkedFilePath(value) {
  const safe = validateManagedPath(value);
  if (Buffer.byteLength(safe) > 4096 ||
      !/^\/docker\/n8n-openai-oauth\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(safe)) {
    throw new TypeError("Remote deployment file path is invalid.");
  }
  return safe;
}

const isMissing = error => error?.code === 2 || error?.code === "ENOENT";
const isDirectory = attrs => (attrs?.mode & constants.S_IFMT) === constants.S_IFDIR;
const isRegular = attrs => (attrs?.mode & constants.S_IFMT) === constants.S_IFREG;
const protectedOwner = attrs => attrs?.uid === 0 && Number.isInteger(attrs.mode) &&
  (attrs.mode & 0o022) === 0;
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
        this.#attest(options, config, Date.now() + timeoutMs),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("The read-only VPS administrative probes timed out. No remote files were written.")), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error?.timedOut === true) throw new Error("The read-only VPS administrative probes timed out. No remote files were written.");
      throw error;
    } finally { clearTimeout(timer); }
  }

  async #attest(options, config, expiresAt) {
    const remaining = () => Math.max(1, expiresAt - Date.now());
    const loginUid = parseLoginUid(await this.#run(LOGIN_PROBE, undefined, remaining()));
    if (options.privilege === "root" && loginUid !== 0) {
      throw new Error("Root administration requires an actual UID 0 login. Select passwordless sudo for the model-only flow.");
    }
    this.#engine = parseAdministrativeProbe(await this.#run(
      administrativeCommand(ADMIN_PROBE, this.#privilege),
      undefined, remaining(),
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

  exec(command, { input, timeoutMs } = {}) {
    if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
      return Promise.reject(new TypeError("Remote command is invalid."));
    }
    if (input !== undefined && (this.#privilege === "sudo-n" ||
        typeof input !== "string" || Buffer.byteLength(input) > 64 * 1024)) {
      return Promise.reject(new TypeError("Remote command input is invalid. Sudo model-only commands do not accept stdin."));
    }
    try {
      return this.#run(administrativeCommand(command, this.#privilege, this.#engine),
        input, deadline(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS));
    } catch (error) { return Promise.reject(error); }
  }

  #run(command, input, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let stream;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const event of ["error", "end", "close"]) this.#client.removeListener(event, interrupted);
        if (error) {
          try { stream?.destroy(); } catch {}
          reject(error);
        } else resolve(result);
      };
      const fail = message => finish(unknownRemoteOutcome(message));
      const interrupted = () => fail("The SSH command was interrupted. Its remote outcome is unknown.");
      const timer = setTimeout(() => finish(Object.assign(
        unknownRemoteOutcome("The SSH command timed out. Its remote outcome is unknown."),
        { timedOut: true },
      )), timeoutMs);
      for (const event of ["error", "end", "close"]) this.#client.once(event, interrupted);
      const started = (error, channel) => {
        stream = channel;
        if (settled) {
          stream?.on("error", () => {});
          try { stream?.destroy(); } catch {}
          return;
        }
        if (error) {
          finish(new Error("The VPS refused to start a remote command."));
          return;
        }
        const stdout = [];
        const stderr = [];
        let byteCount = 0;
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
        stream.on("error", () => fail("The SSH command stream failed."));
        stream.stderr.on("error", () => fail("The SSH command stream failed."));
        stream.once("close", code => {
          if (settled) return;
          if (!Number.isInteger(code)) {
            fail("The SSH command closed without a verified exit status. Its remote outcome is unknown.");
            return;
          }
          finish(null, {
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
      catch { finish(new Error("The VPS refused to start a remote command.")); }
    });
  }

  publishManagedFile(remotePath, contents, mode = 0o600, { timeoutMs } = {}) {
    if (this.#privilege !== "root") throw new TypeError("Managed publication requires root privilege.");
    const safePath = checkedFilePath(remotePath);
    const duration = deadline(timeoutMs, DEFAULT_TRANSFER_TIMEOUT_MS);
    if (![0o600, 0o644].includes(mode) ||
        typeof contents !== "string" && !Buffer.isBuffer(contents)) {
      throw new TypeError("Remote upload contents or mode are invalid.");
    }
    const size = Buffer.isBuffer(contents) ? contents.length : Buffer.byteLength(contents);
    if (size > MAX_UPLOAD_BYTES) throw new TypeError("Remote upload exceeded the safety limit.");
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    const tempPath = checkedFilePath(`${path.dirname(safePath)}/.relmio-${randomUUID()}.tmp`);
    const parents = [];
    for (let parent = path.dirname(safePath); ; parent = path.dirname(parent)) {
      parents.unshift(parent);
      if (parent === "/") break;
    }
    return new Promise((resolve, reject) => {
      let channel;
      let settled = false;
      let tempMayExist = false;
      const expiresAt = Date.now() + duration;
      const finish = (error, timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const event of ["error", "end", "close"]) this.#client.removeListener(event, interrupted);
        try { channel?.end(); } catch {}
        if (!error) { resolve(); return; }
        const failure = tempMayExist
          ? Object.assign(unknownRemoteOutcome(`Managed publication failed. Its remote outcome is unknown; inspect the staged file ${tempPath}.`), { tempPath })
          : fileFailure();
        if (timedOut) failure.timedOut = true;
        reject(failure);
      };
      const interrupted = () => finish(true);
      const timer = setTimeout(() => finish(true, true), duration);
      for (const event of ["error", "end", "close"]) this.#client.once(event, interrupted);
      const call = (method, ...args) => new Promise((done, failed) => {
        if (settled) { failed(fileFailure()); return; }
        try {
          if (method === "open") tempMayExist = true;
          channel[method](...args, (error, result) => {
            if (method === "open" && [2, 3, 4, 8].includes(error?.code)) tempMayExist = false;
            if (settled) failed(fileFailure());
            else if (error) failed(error);
            else done(result);
          });
        } catch (error) {
          if (method === "open") tempMayExist = false;
          failed(error);
        }
      });
      const checkParents = async () => {
        for (const parent of parents) {
          const attrs = await call("lstat", parent);
          if (!isDirectory(attrs) || !protectedOwner(attrs)) throw fileFailure();
        }
      };
      const checkFile = async (name, allowMissing = false) => {
        let attrs;
        try { attrs = await call("lstat", name); }
        catch (error) { if (allowMissing && isMissing(error)) return null; throw error; }
        if (!isRegular(attrs) || !protectedOwner(attrs)) throw fileFailure();
        // SFTP v3 has no reliable link count. GNU stat is read-only, uses a
        // validated literal path, and has the same overall publication deadline.
        const result = await this.#run(
          `/usr/bin/stat -c '%u:%f:%h:%s' -- ${quoteShell(name)}`, undefined,
          Math.max(1, expiresAt - Date.now()),
        );
        if (settled || result.code !== 0 || !/^0:[a-f0-9]{1,8}:1:(0|[1-9][0-9]*)\n?$/u.test(result.stdout)) throw fileFailure();
        const [, rawMode, , rawSize] = result.stdout.trim().split(":");
        const statMode = Number.parseInt(rawMode, 16);
        const statSize = Number(rawSize);
        if (statMode !== attrs.mode || !Number.isSafeInteger(statSize)) throw fileFailure();
        return { mode: statMode & 0o7777, size: statSize };
      };
      const publish = async () => {
        await checkParents();
        await checkFile(safePath, true);
        // SSH_FXF_WRITE | CREAT | EXCL, without TRUNC. Never touch an existing
        // inode. An unacknowledged OPEN can already have created the temp file.
        const handle = await call("open", tempPath, 0x2a, { mode });
        await call("fchmod", handle, mode);
        for (let offset = 0; offset < data.length; offset += 16 * 1024) {
          await call("write", handle, data, offset, Math.min(16 * 1024, data.length - offset), offset);
        }
        await call("ext_openssh_fsync", handle);
        await call("close", handle);
        await checkParents();
        await checkFile(safePath, true);
        const temp = await checkFile(tempPath);
        if (temp.mode !== mode || temp.size !== size) throw fileFailure();
        await call("ext_openssh_rename", tempPath, safePath);
      };
      const ready = (error, sftp) => {
        channel = sftp;
        channel?.on("error", interrupted);
        channel?.once("end", interrupted);
        channel?.once("close", interrupted);
        if (settled) { try { channel?.end(); } catch {} return; }
        if (error || ["lstat", "open", "fchmod", "write", "close", "ext_openssh_fsync", "ext_openssh_rename"]
          .some(method => typeof channel?.[method] !== "function")) { finish(true); return; }
        publish().then(() => finish(), error => finish(true, error?.timedOut === true));
      };
      try { this.#client.sftp(ready); } catch { finish(true); }
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
