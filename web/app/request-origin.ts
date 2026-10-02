import { headers } from "next/headers";

export const canonicalOrigin = new URL("https://relmio.jpfusin.tech");
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/iu;

export async function requestOrigin() {
  const host = (await headers()).get("host");
  if (host && loopbackHost.test(host)) {
    try {
      return new URL(`http://${host}`);
    } catch {
      // Invalid local ports cannot become metadata origins.
    }
  }
  return canonicalOrigin;
}
