import { isIP } from "node:net";

function requireString(value, label, maxLength) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} is invalid.`);
  }

  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    normalized.startsWith("--")
  ) {
    throw new TypeError(`${label} is invalid.`);
  }

  return normalized;
}

export function validateHostname(value) {
  const hostname = requireString(value, "Hostname", 253);
  if (isIP(hostname)) {
    return hostname;
  }
  if (/^[0-9.]+$/.test(hostname)) {
    throw new TypeError("Hostname is invalid.");
  }

  const labels = hostname.split(".");
  const valid = labels.every(
    (label) =>
      label.length <= 63 &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
  );

  if (!valid) {
    throw new TypeError("Hostname is invalid.");
  }

  return hostname.toLowerCase();
}

export function validatePort(value) {
  let port = value;
  if (typeof value !== "number") {
    const text = requireString(value, "Port", 5);
    if (!/^\d{1,5}$/.test(text)) {
      throw new TypeError("Port is invalid.");
    }
    port = Number(text);
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Port is invalid.");
  }

  return port;
}

export function validateUsername(value) {
  const username = requireString(value, "Username", 32);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) {
    throw new TypeError("Username is invalid.");
  }

  return username;
}

export function validateDockerName(value) {
  const name = requireString(value, "Docker name", 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    throw new TypeError("Docker name is invalid.");
  }

  return name;
}
