import assert from "node:assert/strict";
import test from "node:test";

import { PROJECT_META_TTL_MS, createProjectMetaReader } from "../src/services/project-meta.js";

const GITHUB = "https://api.github.com/repos/Demonbane18/relmio";
const WEBSITE = "https://relmio.jpfusin.tech/api/project-meta";

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const answer = routes[url];
    if (answer instanceof Error) throw answer;
    return answer ? Response.json(answer.body, { status: answer.status ?? 200 }) : new Response("", { status: 404 });
  };
  return { calls, fetchImpl };
}

test("the star count comes from GitHub and is reused for 15 minutes, with one request for pages that load together", async () => {
  const clock = { t: 0 };
  const { calls, fetchImpl } = fakeFetch({ [GITHUB]: { body: { stargazers_count: 57 } } });
  const read = createProjectMetaReader({ version: "0.19.1", fetchImpl, now: () => clock.t });
  assert.deepEqual(await Promise.all([read(), read(), read()]), Array(3).fill({ stars: 57, version: "0.19.1" }));
  clock.t = PROJECT_META_TTL_MS - 1;
  await read();
  assert.deepEqual(calls.map(({ url }) => url), [GITHUB]);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["User-Agent"], "relmio/0.19.1");
  clock.t = PROJECT_META_TTL_MS;
  await read();
  assert.equal(calls.length, 2, "an expired count is fetched again");
});

test("when GitHub refuses or fails, the website's cached count is used; when both fail, the last good count stays", async () => {
  for (const refusal of [{ status: 403, body: { message: "API rate limit exceeded" } }, new TypeError("fetch failed")]) {
    const clock = { t: 0 };
    const routes = { [GITHUB]: refusal, [WEBSITE]: { body: { stars: 58, version: "0.19.0" } } };
    const { calls, fetchImpl } = fakeFetch(routes);
    const read = createProjectMetaReader({ version: "0.19.1", fetchImpl, now: () => clock.t });
    assert.deepEqual(await read(), { stars: 58, version: "0.19.1" }, "the running version is shown, not the website's");
    assert.deepEqual(calls.map(({ url }) => url), [GITHUB, WEBSITE]);

    routes[WEBSITE] = { status: 503, body: {} };
    clock.t = PROJECT_META_TTL_MS;
    assert.deepEqual(await read(), { stars: 58, version: "0.19.1" });
  }

  const { fetchImpl } = fakeFetch({ [GITHUB]: { status: 403, body: {} }, [WEBSITE]: { body: { stars: -1 } } });
  assert.deepEqual(await createProjectMetaReader({ version: "0.19.1", fetchImpl })(), { stars: null, version: "0.19.1" },
    "with no good count anywhere the chip shows its unavailable state");
});
