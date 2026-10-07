// Reads the sidecar's Codex image CLI result for both the VPS and the local sidecar. The CLI
// prints one JSON line; only its known top-level fields leave here, never its message or stderr.
const STATES = new Set(["off", "pending", "signed-in", "reauthorize"]);
const MAX_OUTPUT_BYTES = 4096;
// Local text for CLI codes a person can act on.
const ERRORS = new Map([
  ["images_device_login_disabled", "Codex device code sign-in is off for this account. Turn it on in ChatGPT security settings, or ask your workspace admin, then try again."],
  ["images_login_failed", "The Codex sign-in request failed. Try again. If it keeps failing, check that device code sign-in is on in ChatGPT security settings."],
]);

export function readCodexImagesCliResult(result, { allowUnavailable = false } = {}) {
  let output;
  if (typeof result?.stdout === "string" && Buffer.byteLength(result.stdout) <= MAX_OUTPUT_BYTES) {
    try { output = JSON.parse(result.stdout); } catch { /* Classified below by exit code. */ }
  }
  if (result?.code !== 0) {
    if (typeof output?.error === "string" && /^[a-z_]{1,64}$/u.test(output.error)) {
      throw Object.assign(new Error(ERRORS.get(output.error) ??
        "The Codex image sign-in step failed. Check image sign-in status and try again."),
        { code: output.error });
    }
    // A sidecar built before the add-on has no image module to run.
    if (allowUnavailable) return { state: "unavailable" };
    throw new Error("The Codex image sign-in step failed. The existing n8n deployment was not changed.");
  }
  if (!STATES.has(output?.state)) throw new Error("Codex image sign-in returned invalid attestation.");
  const { state, account, pending, outcome, revocation } = output;
  return Object.fromEntries(Object.entries({ state, account, pending, outcome, revocation })
    .filter(([, value]) => value !== undefined));
}
