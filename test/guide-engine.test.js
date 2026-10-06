import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  box, choosePlacement, currentTip, errorInfo, errorTarget, lookupError, overlaps, selectChapter, tipDone,
} from "../src/ui/guide.js";
import { startWizardServer } from "../src/web/server.js";

const sessionToken = "guide-engine-test-session-token-0123456789abcdef";
const PAGES = {
  vps: "index.html", local: "local.html", assistant: "assistant.html",
  "supergrok-vps": "supergrok-vps.html", "local-model-vps": "local-model-vps.html", hosting: "hosting.html",
};

// A fake screen: which selectors are on screen, field values, checked boxes, recorded marks.
function screen({ shown = [], values = {}, checked = [], marks = [] } = {}) {
  const visible = new Set(shown);
  const done = new Set(marks);
  return {
    shown: (selector) => visible.has(selector),
    filled: (selector) => visible.has(selector) && String(values[selector] ?? "").trim() !== "",
    checked: (selector) => checked.includes(selector),
    marked: (tip, kind) => done.has(`${kind}|${tip.id}`),
  };
}

const chapters = [
  { id: "route", panel: "#choices", tips: [{ id: "pick", target: "#route", done: "clicked" }] },
  { id: "server", panel: "#vps-form", tips: [
    { id: "host", target: "#host", done: "filled" },
    { id: "scan", target: "#scan", done: "clicked" },
    { id: "trust", target: "#trust", done: "checked" },
    { id: "wait", target: "#progress", done: "hidden:#progress" },
    { id: "read", target: "#note", done: "manual" },
  ] },
  { id: "ready", panel: "#done", tips: [{ id: "copy", target: "#url", done: "visible:#copied" }] },
];

test("the chapter follows whichever panel is on screen", () => {
  assert.equal(selectChapter(chapters, screen({ shown: ["#choices"] }).shown), 0);
  assert.equal(selectChapter(chapters, screen({ shown: ["#vps-form"] }).shown), 1);
  assert.equal(selectChapter(chapters, screen({ shown: ["#done", "#vps-form"] }).shown), 1, "first match wins");
  assert.equal(selectChapter(chapters, screen({ shown: ["#done"] }).shown), 2);
  assert.equal(selectChapter(chapters, screen().shown), -1);
});

test("the current tip is the first visible tip that is not done", () => {
  const tips = chapters[1].tips;
  assert.equal(currentTip(tips, screen({ shown: ["#host", "#scan"] })), 0);
  assert.equal(currentTip(tips, screen({ shown: ["#host", "#scan"], values: { "#host": "203.0.113.10" } })), 1);
  assert.equal(currentTip(tips, screen({ shown: ["#scan", "#trust"] })), 1, "hidden targets are skipped");
  assert.equal(currentTip(tips, screen({
    shown: ["#host", "#scan", "#trust"], values: { "#host": "  " },
  })), 0, "blank text does not fill a field");
  assert.equal(currentTip(tips, screen({
    shown: ["#host", "#scan", "#trust", "#note"], values: { "#host": "vps.example.com" },
    checked: ["#trust"], marks: ["clicked|scan"],
  })), 4, "a done wait tip with no target on screen is skipped");
  assert.equal(currentTip(tips, screen({
    shown: ["#host", "#note"], values: { "#host": "vps.example.com" }, marks: ["manual|read"],
  })), -1);
});

test("done conditions cover every documented kind", () => {
  const probe = screen({ shown: ["#a", "#a:not([hidden])"], values: { "#a": "x" }, checked: ["#c"], marks: ["changed|t"] });
  assert.equal(tipDone({ id: "t", target: "#a", done: "filled" }, probe), true);
  assert.equal(tipDone({ id: "t", target: "#c", done: "checked" }, probe), true);
  assert.equal(tipDone({ id: "t", target: "#a", done: "changed" }, probe), true);
  assert.equal(tipDone({ id: "t", target: "#a", done: "clicked" }, probe), false);
  assert.equal(tipDone({ id: "t", target: "#a" }, probe), false, "a tip without done waits for Next tip");
  assert.equal(tipDone({ id: "t", target: "#a", done: "visible:#a:not([hidden])" }, probe), true, "selectors keep their colons");
  assert.equal(tipDone({ id: "t", target: "#a", done: "hidden:#a" }, probe), false);
  assert.equal(tipDone({ id: "t", target: "#a", done: "hidden:#gone" }, probe), true);
});

test("error help looks up flags, codes, recovery, status, then the fallback", () => {
  const entry = (title) => ({ title, say: title, steps: [title] });
  const errors = {
    codes: { retryBlocked: entry("flag"), NO_RUNNING_N8N: entry("code"), usage_limit: entry("stop"), CACHE_FULL: entry("local") },
    recovery: { reauthorize: entry("recovery"), none: entry("never") },
    status: { 401: entry("status") },
    fallback: entry("fallback"),
  };
  const title = (error) => lookupError(errors, error)?.title;
  assert.equal(title({ code: "NO_RUNNING_N8N", retryBlocked: true, recovery: "reauthorize", status: 401 }), "flag");
  assert.equal(title({ code: "NO_RUNNING_N8N", recovery: "reauthorize", status: 401 }), "code");
  assert.equal(title({ errorCode: "CACHE_FULL", status: 500 }), "local");
  assert.equal(title({ stoppedReason: "usage_limit" }), "stop");
  assert.equal(title({ code: "unknown", recovery: "reauthorize", status: 401 }), "recovery");
  assert.equal(title({ recovery: "none", status: 401 }), "status", "recovery none is skipped");
  assert.equal(title({ retryBlocked: "yes", status: 503 }), "fallback", "flags count only when true");
  assert.equal(title({ code: "constructor", recovery: "toString" }), "fallback", "inherited keys never match");
  assert.equal(lookupError(null, { code: "NO_RUNNING_N8N" }), null);
});

test("error help points at the page's fix target, else the named field", () => {
  const entry = { targets: { vps: "#host", local: "#local-port" } };
  assert.equal(errorTarget(entry, { param: "port" }, "vps"), "#host");
  assert.equal(errorTarget(entry, { param: "port" }, "hosting"), "#port, [name=\"port\"]");
  assert.equal(errorTarget({}, { param: "bad\"] *, [x" }, "vps"), null);
  assert.equal(errorTarget(null, {}, "vps"), null);
});

test("page errors pass only the lookup fields into the guide", () => {
  const info = errorInfo(Object.assign(new Error("Server address is invalid."), {
    code: "ssh_identity_review_required", recovery: "review-again", status: 409, param: "host",
    retryBlocked: true, remoteOutcomeUnknown: "true", requestId: "req_secret", upstream: { body: "x" },
    stoppedReason: "x".repeat(200),
  }));
  assert.deepEqual(info, {
    code: "ssh_identity_review_required", recovery: "review-again", param: "host", status: 409, retryBlocked: true,
  });
});

test("placement never covers a protected rect and prefers covering less content", () => {
  const field = box(300, 200, 400, 40);
  const primary = box(1100, 660, 120, 40);
  const rail = box(32, 420, 272, 280);
  const corner = box(860, 360, 352, 280);
  const top = box(32, 70, 272, 280);
  assert.equal(choosePlacement([rail, corner], [field, primary]), rail);
  assert.equal(choosePlacement([box(1000, 500, 300, 200), rail], [primary]), rail, "a candidate over the primary action is skipped");
  assert.equal(choosePlacement([box(250, 150, 200, 100)], [field]), null, "no room collapses to the chip");
  const safety = { ...box(32, 300, 272, 160), weight: 1 };
  const stepper = { ...box(32, 70, 272, 200), weight: 1 };
  assert.equal(choosePlacement([rail, top], [], [safety, stepper]), rail, "the rail foot covers less here");
  const controls = { ...box(32, 560, 272, 140), weight: 3 };
  assert.equal(choosePlacement([rail, top], [], [safety, stepper, controls]), top, "covering controls costs more");

  // Random layouts: whatever is chosen never touches a protected rect.
  let seed = 7;
  const random = (max) => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let round = 0; round < 500; round++) {
    const rects = Array.from({ length: 1 + random(4) }, () => box(random(1200), random(700), 20 + random(300), 20 + random(200)));
    const options = Array.from({ length: 1 + random(6) }, () => box(random(1100), random(600), 100 + random(300), 80 + random(300)));
    const chosen = choosePlacement(options, rects, rects.map((rect) => ({ ...rect, weight: 2 })));
    if (chosen) assert.ok(!rects.some((rect) => overlaps(chosen, rect)));
    else assert.ok(options.every((option) => rects.some((rect) => overlaps(option, rect))));
  }
});

async function startPreferences(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), "relmio-guide-preferences-"));
  const wizard = await startWizardServer({ sessionToken, storageRoot, uiFiles: {} });
  t.after(async () => {
    await wizard.close();
    await rm(storageRoot, { recursive: true, force: true });
  });
  const call = (body, headers = {}) => fetch(`${wizard.origin}/api/ui/preferences`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Token": sessionToken, Origin: wizard.origin, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { storageRoot, call, file: join(storageRoot, "ui-preferences.json") };
}

test("guide preference starts unset and keeps on or off across wizard runs", async (t) => {
  const { storageRoot, call, file } = await startPreferences(t);
  assert.deepEqual(await (await call()).json(), {});
  for (const guide of ["on", "off"]) {
    const saved = await call({ guide });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { guide });
    assert.deepEqual(await (await call()).json(), { guide });
  }
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { guide: "off" });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);

  const next = await startWizardServer({ sessionToken, storageRoot, uiFiles: {} });
  t.after(() => next.close());
  const reread = await fetch(`${next.origin}/api/ui/preferences`, { headers: { "X-Setup-Token": sessionToken } });
  assert.deepEqual(await reread.json(), { guide: "off" }, "a new run on a new port reads the saved choice");
});

test("guide preference accepts only on or off behind the wizard guards", async (t) => {
  const { call, file } = await startPreferences(t);
  for (const body of [{ guide: "maybe" }, { guide: "on", extra: true }, {}, ["on"], "null", { guide: true }]) {
    assert.equal((await call(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call({ guide: "on" }, { "X-Setup-Token": "wrong" })).status, 401);
  assert.equal((await call(undefined, { "X-Setup-Token": "" })).status, 401);
  assert.equal((await call({ guide: "on" }, { Origin: "http://evil.example" })).status, 403);
  await assert.rejects(stat(file), { code: "ENOENT" }, "rejected requests write nothing");

  await writeFile(file, "{not json");
  assert.deepEqual(await (await call()).json(), {}, "a damaged file reads as unset");
  await writeFile(file, JSON.stringify({ guide: "sideways" }));
  assert.deepEqual(await (await call()).json(), {});
});

test("every wizard page loads the guide and names its content", async () => {
  for (const [page, file] of Object.entries(PAGES)) {
    const html = await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    assert.match(html, new RegExp(`<body[^>]*\\sdata-guide-page="${page}"`, "u"), file);
    assert.match(html, /<link rel="stylesheet" href="\/guide\.css" \/>/u, file);
    assert.match(html, /<script src="\/guide\.js" type="module"><\/script>/u, file);
    assert.match(html, /<button id="guide-toggle"[^>]*aria-pressed="false"[^>]*hidden>/u, file);
  }
});

test("the wizard serves the guide engine, mascot and every page's content", async (t) => {
  const wizard = await startWizardServer({ sessionToken });
  t.after(() => wizard.close());
  const paths = ["/guide.js", "/guide-dock.js", "/mascot.js", "/guide/errors.js",
    ...Object.keys(PAGES).map((page) => `/guide/content-${page}.js`)];
  for (const path of [...paths, "/guide.css"]) {
    const response = await fetch(`${wizard.origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
  }
});
