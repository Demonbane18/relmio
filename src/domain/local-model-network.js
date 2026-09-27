const BRIDGE_OPTION = "com.docker.network.bridge.";

// This checks Docker's declared unpublished-port filtering, not the host firewall.
// The host administrator and every peer on the selected bridge remain trusted.
// https://docs.docker.com/engine/network/port-publishing/#gateway-modes
export function assertLocalModelNetworkEligibility(network) {
  if (!network || network.Driver !== "bridge" || network.Scope !== "local" || network.Internal !== false) {
    throw new Error("The model requires an existing local bridge network with registry egress (not an internal network).");
  }
  const options = network.Options ?? {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error("The selected model bridge network options cannot be verified.");
  }
  for (const flag of ["EnableIPv4", "EnableIPv6"]) {
    if (network[flag] !== undefined && typeof network[flag] !== "boolean") {
      throw new Error("The selected model bridge network address families cannot be verified.");
    }
  }
  if (network.EnableIPv4 === false && network.EnableIPv6 === false) {
    throw new Error("The selected model bridge network has no enabled address family.");
  }
  for (const [family, enabled] of [["ipv4", network.EnableIPv4], ["ipv6", network.EnableIPv6]]) {
    // Older inspect responses omit family flags. Only an explicit false proves
    // that a configured gateway mode is irrelevant to this network.
    if (enabled === false) continue;
    const mode = options[`${BRIDGE_OPTION}gateway_mode_${family}`];
    if (mode === undefined || mode === "" || mode === "nat" || mode === "routed") continue;
    if (mode === "nat-unprotected") {
      throw new Error("The selected bridge network uses nat-unprotected, which exposes unpublished model ports through direct routing. Ask an administrator to provide an eligible filtered bridge; Relmio will not change n8n or its network.");
    }
    throw new Error("The selected model bridge network gateway mode cannot provide verified port filtering and registry egress.");
  }
  const defaultBridge = options[`${BRIDGE_OPTION}default_bridge`];
  const interContainer = options[`${BRIDGE_OPTION}enable_icc`];
  if (network.Name === "bridge" || defaultBridge !== undefined && defaultBridge !== "false" ||
      interContainer !== undefined && interContainer !== "true") {
    throw new Error("The model requires a user-defined bridge network with inter-container communication and DNS aliases enabled.");
  }
  // trusted_host_interfaces and daemon allow-direct-routing affect published
  // ports. In nat/routed mode they do not expose this runtime's unpublished port.
  // Do not reject them, host binding addresses, or masquerade settings as proof
  // of exposure. External routing/firewall policy is an administrator boundary.
}
