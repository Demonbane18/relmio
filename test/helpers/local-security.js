export const noOpLocalPathLockDown = async () => {};

export async function testLocalProcessIdentity(processId) {
  return {
    state: "active",
    startIdentity: `relmio-test-process-${processId}`,
  };
}

/**
 * Unit tests exercise service behavior with ordinary filesystem fixtures.
 * They must not depend on the host account's Windows ACL ownership or process
 * identity APIs; dedicated infrastructure tests cover those real boundaries.
 */
export function withTestLocalSecurity(dependencies = {}) {
  const hasExplicitProcessLiveness =
    dependencies.getProcessIdentity !== undefined ||
    dependencies.processIdentity !== undefined ||
    dependencies.isProcessAlive !== undefined;
  const processIdentity = dependencies.processIdentity ??
    dependencies.getProcessIdentity ??
    (hasExplicitProcessLiveness ? undefined : testLocalProcessIdentity);
  return {
    ...dependencies,
    lockDownPath: dependencies.lockDownPath ?? noOpLocalPathLockDown,
    ...(processIdentity === undefined ? {} : {
      getProcessIdentity: dependencies.getProcessIdentity ?? processIdentity,
      processIdentity,
    }),
  };
}
