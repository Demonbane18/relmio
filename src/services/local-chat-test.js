import {
  constants,
  generateKeyPair as generateKeyPairCallback,
  privateDecrypt,
  randomUUID,
} from "node:crypto";
import { promisify } from "node:util";

const generateKeyPair = promisify(generateKeyPairCallback);

const MAX_SESSIONS = 8;
const KEY_TTL_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ENDPOINT_LENGTH = 64;
const MAX_CIPHERTEXT_LENGTH = 4_096;
const MAX_INPUT_LENGTH = 8_192;
const MAX_CONVERSATION_ID_LENGTH = 160;
const MAX_RESPONSE_BYTES = 512 * 1_024;
const MAX_OUTPUT_LENGTH = 12 * 1_024;

function requestError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function expiredKeyError() {
  return requestError(
    "This test credential has expired or was forgotten. Secure it again.",
    409,
  );
}

function adapterError(statusCode = 502) {
  return requestError("The local adapter test could not be completed.", statusCode);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function parseLocalAdapterBaseUrl(value) {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) {
    throw requestError("Enter a valid local adapter address.");
  }

  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/u.exec(value);
  if (!match) {
    throw requestError("Enter a valid local adapter address.");
  }

  const port = Number(match[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw requestError("Enter a valid local adapter address.");
  }

  return `http://127.0.0.1:${port}`;
}

function validateMessageRequest(request) {
  if (!isPlainObject(request)) {
    throw requestError("Enter a valid local adapter test request.");
  }
  const endpointBaseUrl = parseLocalAdapterBaseUrl(request.endpointBaseUrl);
  if (!isBoundedText(request.keyId, 128)) {
    throw expiredKeyError();
  }
  if (
    typeof request.encryptedCredential !== "string" ||
    request.encryptedCredential.length < 32 ||
    request.encryptedCredential.length > MAX_CIPHERTEXT_LENGTH ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(request.encryptedCredential)
  ) {
    throw requestError("Secure the client credential again before testing.");
  }
  if (!isBoundedText(request.input, MAX_INPUT_LENGTH)) {
    throw requestError("Enter a shorter chat message.");
  }
  if (
    request.conversationId !== undefined &&
    !isBoundedText(request.conversationId, MAX_CONVERSATION_ID_LENGTH)
  ) {
    throw requestError("Start a new conversation and try again.");
  }

  return {
    endpointBaseUrl,
    keyId: request.keyId,
    encryptedCredential: request.encryptedCredential,
    input: request.input,
    ...(request.conversationId !== undefined
      ? { conversationId: request.conversationId }
      : {}),
  };
}

function decodeCiphertext(value) {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64") !== value
  ) {
    decoded.fill(0);
    throw requestError("Secure the client credential again before testing.");
  }
  return decoded;
}

async function readBoundedResponse(response) {
  const contentLength = response.headers?.get?.("content-length");
  if (
    contentLength !== null &&
    contentLength !== undefined &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw adapterError();
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw adapterError();
  }

  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        chunk.fill(0);
        throw adapterError();
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    for (const chunk of chunks) {
      chunk.fill(0);
    }
    reader.releaseLock?.();
  }
}

function parseAdapterResponse(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw adapterError();
  }
  if (
    !isPlainObject(value) ||
    !isBoundedText(value.conversationId, MAX_CONVERSATION_ID_LENGTH) ||
    !isBoundedText(value.output, MAX_OUTPUT_LENGTH)
  ) {
    throw adapterError();
  }
  return {
    conversationId: value.conversationId,
    output: value.output,
  };
}

function parseEventBlock(block) {
  const dataLines = [];
  let event;
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!event || dataLines.length === 0) {
    throw adapterError();
  }
  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    throw adapterError();
  }
  if (!isPlainObject(data)) {
    throw adapterError();
  }
  return { event, data };
}

async function consumeAdapterStream(response, onEvent) {
  if (
    !/^text\/event-stream(?:\s*;|$)/iu.test(
      response.headers?.get?.("content-type") ?? "",
    ) ||
    response.headers?.get?.("x-relmio-stream") !== "v1"
  ) {
    throw adapterError();
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    throw adapterError();
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let conversationId;
  let failed = false;
  let output = "";
  let terminal = false;
  const processBlock = (block) => {
    if (!block.trim() || block.trimStart().startsWith(":")) {
      return;
    }
    const { event, data } = parseEventBlock(block);
    if (event === "start") {
      return;
    }
    if (event === "progress") {
      onEvent("progress", { phase: "working" });
      return;
    }
    if (event === "delta") {
      if (
        typeof data.text !== "string" ||
        data.text.length === 0 ||
        data.text.includes("\0") ||
        output.length + data.text.length > MAX_OUTPUT_LENGTH
      ) {
        throw adapterError();
      }
      output += data.text;
      onEvent("delta", { text: data.text });
      return;
    }
    if (event === "error") {
      failed = true;
      return;
    }
    if (event === "terminal") {
      if (terminal || !["completed", "failed"].includes(data.outcome)) {
        throw adapterError();
      }
      terminal = true;
      failed ||= data.outcome !== "completed";
      if (!failed) {
        if (!isBoundedText(data.conversationId, MAX_CONVERSATION_ID_LENGTH)) {
          throw adapterError();
        }
        conversationId = data.conversationId;
      }
      return;
    }
    throw adapterError();
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw adapterError();
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) processBlock(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The adapter stream may already be closed after a malformed terminal.
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }

  if (failed || !terminal || !conversationId || output.length === 0) {
    throw adapterError();
  }
  return { conversationId, output };
}

function isTimeout(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError";
}

export function createLocalChatTestService({
  fetchImpl = fetch,
  now = () => Date.now(),
  keyTtlMs = KEY_TTL_MS,
  maxSessions = MAX_SESSIONS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const sessions = new Map();
  let pendingKeyIssuances = 0;
  let sessionGeneration = 0;

  function expireSession(keyId, session) {
    if (sessions.get(keyId) !== session) {
      return;
    }
    clearTimeout(session.expiryTimer);
    session.abortController?.abort();
    session.privateKey = undefined;
    sessions.delete(keyId);
  }

  function discardExpiredSessions() {
    const currentTime = now();
    for (const [keyId, session] of sessions) {
      if (session.expiresAt <= currentTime) {
        expireSession(keyId, session);
      }
    }
  }

  function resetAllSessions() {
    sessionGeneration += 1;
    for (const [keyId, session] of sessions) {
      expireSession(keyId, session);
    }
  }

  function getLiveSession(keyId) {
    discardExpiredSessions();
    const session = sessions.get(keyId);
    if (!session || session.expiresAt <= now()) {
      if (session) {
        expireSession(keyId, session);
      }
      throw expiredKeyError();
    }
    return session;
  }

  return {
    async issueKey() {
      const issueGeneration = sessionGeneration;
      discardExpiredSessions();
      if (sessions.size + pendingKeyIssuances >= maxSessions) {
        throw requestError(
          "Too many open tester sessions. Forget one or wait for it to expire.",
          429,
        );
      }
      pendingKeyIssuances += 1;
      try {
        const { publicKey, privateKey } = await generateKeyPair("rsa", {
          modulusLength: 2_048,
          publicExponent: 0x10001,
        });
        if (sessionGeneration !== issueGeneration) {
          throw expiredKeyError();
        }
        const keyId = randomUUID();
        const expiresAt = now() + keyTtlMs;
        const session = {
          abortController: null,
          expiresAt,
          expiryTimer: null,
          inFlight: false,
          privateKey,
        };
        sessions.set(keyId, session);
        session.expiryTimer = setTimeout(
          () => expireSession(keyId, session),
          keyTtlMs,
        );
        session.expiryTimer.unref?.();
        return {
          keyId,
          publicKeyJwk: publicKey.export({ format: "jwk" }),
          algorithm: "RSA-OAEP-256",
          expiresAt: new Date(expiresAt).toISOString(),
        };
      } finally {
        pendingKeyIssuances -= 1;
      }
    },

    async message(untrustedRequest, options = {}) {
      const request = validateMessageRequest(untrustedRequest);
      const onEvent =
        typeof options.onEvent === "function" ? options.onEvent : null;
      const externalSignal =
        options.signal instanceof AbortSignal ? options.signal : null;
      const session = getLiveSession(request.keyId);
      if (session.inFlight) {
        throw requestError("Wait for the current test message to finish.", 409);
      }
      session.inFlight = true;
      let encryptedCredential;
      let decryptedCredential;
      let authorization;
      let abortFromCaller;
      let timeout;
      try {
        encryptedCredential = decodeCiphertext(request.encryptedCredential);
        try {
          decryptedCredential = privateDecrypt(
            {
              key: session.privateKey,
              padding: constants.RSA_PKCS1_OAEP_PADDING,
              oaepHash: "sha256",
            },
            encryptedCredential,
          );
        } catch {
          throw requestError("Secure the client credential again before testing.");
        }
        if (
          decryptedCredential.length === 0 ||
          decryptedCredential.length > 512 ||
          /[\r\n\u0000]/u.test(decryptedCredential.toString("utf8"))
        ) {
          throw requestError("Secure the client credential again before testing.");
        }
        authorization = `Bearer ${decryptedCredential.toString("utf8")}`;

        let response;
        try {
          session.abortController = new AbortController();
          abortFromCaller = () => session.abortController?.abort();
          if (externalSignal?.aborted) {
            abortFromCaller();
          } else {
            externalSignal?.addEventListener("abort", abortFromCaller, {
              once: true,
            });
          }
          timeout = setTimeout(
            () => session.abortController?.abort(),
            requestTimeoutMs,
          );
          response = await fetchImpl(`${request.endpointBaseUrl}/chat`, {
            method: "POST",
            headers: {
              Accept: onEvent ? "text/event-stream" : "application/json",
              Authorization: authorization,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              input: request.input,
              ...(request.conversationId !== undefined
                ? { conversationId: request.conversationId }
                : {}),
            }),
            redirect: "error",
            signal: session.abortController.signal,
          });
        } catch (error) {
          throw adapterError(isTimeout(error) ? 504 : 502);
        }
        if (!response?.ok || response.status < 200 || response.status >= 300) {
          throw adapterError();
        }
        return onEvent
          ? await consumeAdapterStream(response, onEvent)
          : parseAdapterResponse(await readBoundedResponse(response));
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abortFromCaller);
        authorization = undefined;
        encryptedCredential?.fill(0);
        decryptedCredential?.fill(0);
        session.abortController = null;
        session.inFlight = false;
      }
    },

    async reset(request) {
      if (!isPlainObject(request) || !isBoundedText(request.keyId, 128)) {
        throw requestError("Choose a valid tester session to forget.");
      }
      const session = sessions.get(request.keyId);
      if (session) {
        expireSession(request.keyId, session);
      }
      return { forgotten: true };
    },

    resetAll() {
      resetAllSessions();
    },

    dispose() {
      resetAllSessions();
    },
  };
}
