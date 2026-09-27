// Service-isolated HTTP tests explicitly model a successfully attested transport.
// Transport-to-HTTP boundary tests use the real connectVerified export instead.
export function verifiedSshFixture(request, remote = { close() {} }) {
  remote.identity = Object.freeze({
    host: request.host, port: Number(request.port), fingerprint: request.expectedFingerprint,
    username: request.username, authentication: request.useAgent ? "agent" : "password",
    privilege: request.privilege, loginUid: request.privilege === "root" ? 0 : 1000, effectiveUid: 0,
  });
  remote.scope = request.privilege === "root" ? "vps" : "local-model-only";
  return remote;
}
