import { timingSafeEqual } from "node:crypto";
import { posix as path } from "node:path";
import ssh2 from "ssh2";

import { INSTALL_ROOT } from "../domain/safety.js";
import {
  validateHostname,
  validatePort,
  validateUsername,
} from "../domain/validation.js";

const { Client } = ssh2;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;

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

export function buildVerifiedConnectionConfig({
  host,
  port,
  username,
  password,
  agent,
  expectedFingerprint,
}) {
  const fingerprint = validateExpectedFingerprint(expectedFingerprint);
  const auth =
    typeof password === "string" && password.length > 0
      ? { password: validatePassword(password) }
      : typeof agent === "string" && agent.length > 0
        ? { agent }
        : null;

  if (!auth) {
    throw new TypeError("An SSH password or agent is required.");
  }

  return {
    host: validateHostname(host),
    port: validatePort(port),
    username: validateUsername(username),
    ...auth,
    hostHash: "sha256",
    hostVerifier(hexDigest) {
      const actual = formatSha256Fingerprint(hexDigest);
      return fingerprintsMatch(actual, fingerprint);
    },
    readyTimeout: 15_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    tryKeyboard: false,
  };
}

class SshConnection {
  constructor(client) {
    this.client = client;
    this.lastError = null;
    client.on("error", (error) => {
      this.lastError = error;
    });
  }

  exec(command) {
    if (typeof command !== "string" || command.length === 0) {
      return Promise.reject(new TypeError("Remote command is invalid."));
    }

    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(new Error("The VPS refused to start a remote command."));
          return;
        }

        const stdout = [];
        const stderr = [];
        let byteCount = 0;
        let settled = false;

        const append = (target, chunk) => {
          byteCount += chunk.length;
          if (byteCount > MAX_COMMAND_OUTPUT_BYTES) {
            settled = true;
            stream.destroy();
            reject(new Error("Remote command output exceeded the safety limit."));
            return;
          }
          target.push(Buffer.from(chunk));
        };

        stream.on("data", (chunk) => {
          if (!settled) {
            append(stdout, chunk);
          }
        });
        stream.stderr.on("data", (chunk) => {
          if (!settled) {
            append(stderr, chunk);
          }
        });
        stream.once("error", () => {
          if (!settled) {
            settled = true;
            reject(new Error("The SSH command stream failed."));
          }
        });
        stream.once("close", (code) => {
          if (!settled) {
            settled = true;
            resolve({
              stdout: Buffer.concat(stdout).toString("utf8"),
              stderr: Buffer.concat(stderr).toString("utf8"),
              code: Number.isInteger(code) ? code : 1,
            });
          }
        });
      });
    });
  }

  upload(remotePath, contents, mode = 0o600) {
    const safePath = validateManagedPath(remotePath);
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);

    return new Promise((resolve, reject) => {
      this.client.sftp((sftpError, sftp) => {
        if (sftpError) {
          reject(new Error("The VPS did not allow an SFTP upload."));
          return;
        }

        sftp.writeFile(safePath, data, { mode, flag: "w" }, (writeError) => {
          sftp.end();
          if (writeError) {
            reject(new Error("The installer could not upload a sidecar file."));
          } else {
            resolve();
          }
        });
      });
    });
  }

  close() {
    this.client.end();
  }
}

export async function connectVerified(
  options,
  { createClient = () => new Client() } = {},
) {
  const config = buildVerifiedConnectionConfig(options);

  return await new Promise((resolve, reject) => {
    const client = createClient();
    let settled = false;

    client.once("ready", () => {
      settled = true;
      resolve(new SshConnection(client));
    });
    client.once("error", () => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "SSH connection failed. Check the address, password, firewall, and confirmed fingerprint.",
          ),
        );
      }
    });
    client.connect(config);
  });
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

    client.once("error", () => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "The VPS did not answer on the SSH port. Check its IP address and firewall.",
          ),
        );
      }
    });

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
