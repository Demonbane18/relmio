// Docker networks on which a Relmio container certainly cannot work. Only
// certain failures are refused: overlay, macvlan and records with missing or
// unknown fields pass, and each flow keeps its own stricter attestation.
export const VPS_NETWORK_UNSUPPORTED = "vps_network_unsupported";

const DEFAULT_BRIDGE_OPTION = "com.docker.network.bridge.default_bridge";
const NEXT_STEP = "Attach n8n to a user-defined Docker network, then check again.";
const MESSAGES = Object.freeze({
  "default-bridge": `The selected network is Docker's default bridge. Containers on it cannot find each other by name, so n8n could not reach the Relmio container. ${NEXT_STEP}`,
  host: `The selected network is Docker's host network. It has no container names, so n8n could not reach the Relmio container. ${NEXT_STEP}`,
  none: `The selected network is Docker's none network, which carries no traffic. ${NEXT_STEP}`,
  internal: "The selected network is internal, so a container on it cannot reach the internet. Choose a network with outbound access, then check again.",
});

// `network` is one parsed `docker network inspect` record. Docker reserves the
// names bridge, host and none for its predefined networks.
export function describeVpsNetworkSupport(network, { outbound = true } = {}) {
  const name = network?.Name;
  const driver = network?.Driver;
  const reason = name === "bridge" || network?.Options?.[DEFAULT_BRIDGE_OPTION] === "true" ? "default-bridge"
    : driver === "host" || name === "host" ? "host"
      : driver === "null" || name === "none" ? "none"
        : outbound && network?.Internal === true ? "internal" : null;
  return Object.freeze({ supported: reason === null, reason, message: reason === null ? null : MESSAGES[reason] });
}

export function assertVpsNetworkSupported(network, options) {
  const { supported, reason, message } = describeVpsNetworkSupport(network, options);
  if (!supported) throw Object.assign(new Error(message), { code: VPS_NETWORK_UNSUPPORTED, reason });
}
