// Star count for the top bar's GitHub chip. GitHub allows 60 unauthenticated API calls an hour
// per address, so one wizard session that opens many pages, or several sessions, could use them up
// and the chip showed "?". Keep a good count for 15 minutes, share one request between pages that
// load together, ask Relmio's website (which caches the same count) when GitHub refuses, and keep
// the last good count when both fail.

const GITHUB_URL = "https://api.github.com/repos/Demonbane18/relmio";
const WEBSITE_URL = "https://relmio.jpfusin.tech/api/project-meta";
export const PROJECT_META_TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 5_000;
// After both sources fail, answer from the last count for a minute instead of waiting on them again.
export const PROJECT_META_RETRY_MS = 60_000;

const validStars = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

async function readStars(fetchImpl, url, headers, pick) {
  try {
    const response = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? validStars(pick(await response.json())) : null;
  } catch {
    return null;
  }
}

export function createProjectMetaReader({ version, fetchImpl = fetch, now = Date.now } = {}) {
  const headers = { "User-Agent": `relmio/${version}` };
  let cached = null;
  let pending = null;
  let retryAt = 0;

  async function refresh() {
    const stars = await readStars(fetchImpl, GITHUB_URL, { ...headers, Accept: "application/vnd.github+json" },
      (body) => body?.stargazers_count)
      ?? await readStars(fetchImpl, WEBSITE_URL, { ...headers, Accept: "application/json" }, (body) => body?.stars);
    if (stars !== null) cached = { stars, at: now() };
    else retryAt = now() + PROJECT_META_RETRY_MS;
    return cached?.stars ?? null;
  }

  return async function getProjectMeta() {
    const at = now();
    if ((cached && at - cached.at < PROJECT_META_TTL_MS) || at < retryAt) return { stars: cached?.stars ?? null, version };
    pending ??= refresh().finally(() => { pending = null; });
    return { stars: await pending, version };
  };
}
