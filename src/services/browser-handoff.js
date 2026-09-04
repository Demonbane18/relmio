import { randomBytes as createRandomBytes } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { lockDownLocalPath } from "../infrastructure/local-process.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ROUTES = new Set(["/", "/assistant", "/local"]);
const MAX_HANDOFF_BYTES = 8 * 1024;

function fail(message = "could not create a private browser handoff") {
  return new Error(`Relmio ${message}.`);
}

function validateOrigin(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
      parsed.port === "" || parsed.pathname !== "/" || parsed.search || parsed.hash ||
      parsed.username || parsed.password || value !== parsed.origin
    ) throw new TypeError();
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError();
    return parsed.origin;
  } catch {
    throw new TypeError("Relmio browser handoff origin is invalid.");
  }
}

function validateInputs({ origin, route, ticketId, secret, privateRoot }) {
  const validatedOrigin = validateOrigin(origin);
  if (
    !ROUTES.has(route) || !TOKEN_PATTERN.test(ticketId) || !TOKEN_PATTERN.test(secret) ||
    typeof privateRoot !== "string" || !isAbsolute(privateRoot) ||
    privateRoot.includes("\0")
  ) {
    throw new TypeError("Relmio browser handoff input is invalid.");
  }
  return { origin: validatedOrigin, route };
}

function privateMetadata(metadata, { kind, platform, expectedUid, maxBytes }) {
  if (
    !metadata || metadata.isSymbolicLink?.() ||
    (kind === "directory" ? !metadata.isDirectory?.() : !metadata.isFile?.()) ||
    (kind === "file" && metadata.nlink !== 1) ||
    (kind === "file" && metadata.size > maxBytes)
  ) return false;
  if (platform !== "win32") {
    const expectedMode = kind === "directory" ? 0o700 : 0o600;
    if ((metadata.mode & 0o777) !== expectedMode || metadata.uid !== expectedUid) return false;
  }
  return true;
}

function pathFingerprint(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeMs: metadata.birthtimeMs,
  };
}

function samePathFingerprint(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs;
}

async function inspectPrivatePath({
  fileSystem, path, kind, platform, expectedUid, lockDownPath, maxBytes,
}) {
  const before = await fileSystem.lstat(path);
  if (!privateMetadata(before, { kind, platform, expectedUid, maxBytes })) {
    throw fail("refuses an unsafe private browser handoff path");
  }
  if (platform === "win32") {
    await lockDownPath(path, { platform, kind, verifyOnly: true });
  }
  const after = await fileSystem.lstat(path);
  if (
    !privateMetadata(after, { kind, platform, expectedUid, maxBytes }) ||
    !samePathFingerprint(pathFingerprint(before), pathFingerprint(after))
  ) {
    throw fail("detected a replaced private browser handoff path");
  }
  return after;
}

function handoffHtml({ origin, route, ticketId, secret }) {
  const action = `${origin}/__relmio/browser/bootstrap`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; form-action ${origin}">
  <title>Opening Relmio</title>
</head>
<body>
  <form method="post" action="${action}">
    <input type="hidden" name="ticketId" value="${ticketId}">
    <input type="hidden" name="secret" value="${secret}">
    <input type="hidden" name="route" value="${route}">
  </form>
  <script>document.forms[0].submit();</script>
</body>
</html>`;
}

async function cleanupExact({ fileSystem, filePath, fileFingerprint, directoryPath, directoryFingerprint }) {
  try {
    const currentFile = await fileSystem.lstat(filePath);
    if (!samePathFingerprint(pathFingerprint(currentFile), fileFingerprint)) return false;
    await fileSystem.unlink(filePath);
    const currentDirectory = await fileSystem.lstat(directoryPath);
    if (!samePathFingerprint(pathFingerprint(currentDirectory), directoryFingerprint)) return false;
    if ((await fileSystem.readdir(directoryPath)).length !== 0) return false;
    await fileSystem.rmdir(directoryPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a one-use browser handoff. The Windows file is locked while empty,
 * before the bootstrap secret is written. Its random path is only a locator;
 * possession of the protected file contents is required to authorize exchange.
 */
export async function createPrivateBrowserHandoff({
  origin,
  route,
  ticketId,
  secret,
  privateRoot,
  fileSystem = defaultFileSystem,
  platform = process.platform,
  lockDownPath = lockDownLocalPath,
  getUid = process.getuid?.bind(process),
  randomBytes = createRandomBytes,
} = {}) {
  const validated = validateInputs({ origin, route, ticketId, secret, privateRoot });
  if (
    !fileSystem || typeof fileSystem.realpath !== "function" ||
    typeof fileSystem.mkdtemp !== "function" || typeof fileSystem.open !== "function" ||
    typeof fileSystem.lstat !== "function" || typeof lockDownPath !== "function" ||
    typeof randomBytes !== "function"
  ) throw new TypeError("Relmio browser handoff adapter is invalid.");
  const expectedUid = platform === "win32" ? null : getUid?.();
  if (platform !== "win32" && (!Number.isSafeInteger(expectedUid) || expectedUid < 0)) {
    throw new TypeError("Relmio browser handoff account is invalid.");
  }
  const requestedPrivateRoot = resolve(privateRoot);
  const canonicalPrivateRoot = await fileSystem.realpath(requestedPrivateRoot);
  if (!isAbsolute(canonicalPrivateRoot) || canonicalPrivateRoot !== requestedPrivateRoot) {
    throw fail("refuses a redirected private browser handoff root");
  }
  const privateRootMetadata = await inspectPrivatePath({
    fileSystem,
    path: canonicalPrivateRoot,
    kind: "directory",
    platform,
    expectedUid,
    lockDownPath,
    maxBytes: 0,
  });
  const privateRootFingerprint = pathFingerprint(privateRootMetadata);

  const directoryPath = await fileSystem.mkdtemp(join(canonicalPrivateRoot, "relmio-browser-"));
  let handle;
  let filePath;
  let fileFingerprint;
  let directoryFingerprint;
  try {
    await fileSystem.chmod(directoryPath, 0o700);
    await lockDownPath(directoryPath, { platform, kind: "directory" });
    const directoryMetadata = await inspectPrivatePath({
      fileSystem,
      path: directoryPath,
      kind: "directory",
      platform,
      expectedUid,
      lockDownPath,
      maxBytes: 0,
    });
    directoryFingerprint = pathFingerprint(directoryMetadata);
    const currentPrivateRoot = await inspectPrivatePath({
      fileSystem,
      path: canonicalPrivateRoot,
      kind: "directory",
      platform,
      expectedUid,
      lockDownPath,
      maxBytes: 0,
    });
    if (!samePathFingerprint(privateRootFingerprint, pathFingerprint(currentPrivateRoot))) {
      throw fail("detected a replaced private browser handoff root");
    }

    const filenameRandom = randomBytes(12);
    if (!Buffer.isBuffer(filenameRandom) || filenameRandom.length !== 12) {
      throw new TypeError("Relmio browser handoff randomness is invalid.");
    }
    filePath = join(directoryPath, `launch-${filenameRandom.toString("hex")}.html`);
    if (basename(dirname(filePath)) !== basename(directoryPath)) throw fail();
    handle = await fileSystem.open(filePath, "wx", 0o600);
    await handle.chmod(0o600);
    const created = await handle.stat();
    if (!privateMetadata(created, {
      kind: "file", platform, expectedUid, maxBytes: MAX_HANDOFF_BYTES,
    })) throw fail("could not protect its private browser handoff file");
    await lockDownPath(filePath, { platform, kind: "file" });
    const protectedFile = await inspectPrivatePath({
      fileSystem,
      path: filePath,
      kind: "file",
      platform,
      expectedUid,
      lockDownPath,
      maxBytes: MAX_HANDOFF_BYTES,
    });
    if (!samePathFingerprint(pathFingerprint(created), pathFingerprint(protectedFile))) {
      throw fail("detected a replaced private browser handoff file");
    }
    const currentDirectory = await inspectPrivatePath({
      fileSystem,
      path: directoryPath,
      kind: "directory",
      platform,
      expectedUid,
      lockDownPath,
      maxBytes: 0,
    });
    if (!samePathFingerprint(directoryFingerprint, pathFingerprint(currentDirectory))) {
      throw fail("detected a replaced private browser handoff directory");
    }

    const contents = handoffHtml({ ...validated, ticketId, secret });
    if (Buffer.byteLength(contents) > MAX_HANDOFF_BYTES) throw fail();
    await handle.writeFile(contents, "utf8");
    await handle.sync?.();
    const written = await handle.stat();
    if (
      !samePathFingerprint(pathFingerprint(created), pathFingerprint(written)) ||
      written.size !== Buffer.byteLength(contents)
    ) throw fail("could not verify its private browser handoff write");
    await handle.close();
    handle = null;

    const verifiedFile = await inspectPrivatePath({
      fileSystem,
      path: filePath,
      kind: "file",
      platform,
      expectedUid,
      lockDownPath,
      maxBytes: MAX_HANDOFF_BYTES,
    });
    fileFingerprint = pathFingerprint(verifiedFile);
    return Object.freeze({
      launchUrl: pathToFileURL(filePath).href,
      async dispose() {
        return await cleanupExact({
          fileSystem,
          filePath,
          fileFingerprint,
          directoryPath,
          directoryFingerprint,
        });
      },
    });
  } catch (error) {
    try { await handle?.close(); } catch { /* Preserve the creation failure. */ }
    if (filePath && fileFingerprint && directoryFingerprint) {
      await cleanupExact({ fileSystem, filePath, fileFingerprint, directoryPath, directoryFingerprint });
    } else {
      try {
        if ((await fileSystem.readdir(directoryPath)).length === 0) {
          await fileSystem.rmdir(directoryPath);
        }
      } catch { /* Preserve protected residue rather than deleting an uncertain path. */ }
    }
    throw error?.message?.startsWith("Relmio ") ? error : fail();
  }
}

export const BROWSER_HANDOFF_ROUTES = Object.freeze(["/", "/assistant", "/local"]);
