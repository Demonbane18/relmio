import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  box, choosePlacement, currentTip, errorInfo, errorTarget, lookupError, overlaps, selectChapter, tipDone, visitOutcome,
} from "../src/ui/guide.js";
import { candidates, cursorSpot, placeDock, stackMarkers, visiblePart } from "../src/ui/guide-dock.js";
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

test("a badge needs every action tip seen done; the guide finishes on the last chapter", () => {
  const tips = chapters[1].tips;
  const done = (...ids) => (tip) => ids.includes(tip.id);
  assert.equal(visitOutcome(tips, done("host", "scan", "trust", "wait")).badge, true, "reading tips are optional");
  assert.equal(visitOutcome(tips, done("host", "scan", "trust")).badge, false, "an unfinished wait tip keeps the badge");
  assert.equal(visitOutcome(tips.slice(0, 2), done("host", "scan")).badge, true, "only tips seen count");
  assert.equal(visitOutcome([{ id: "x", target: "#x" }], done()).badge, true, "a tip without done is a reading tip");
  assert.equal(visitOutcome([], done()).badge, false, "nothing seen earns nothing");

  assert.deepEqual(visitOutcome(tips, done("host"), { last: true, current: -1 }), { badge: false, finished: true },
    "finishing does not award a badge the visit did not earn");
  assert.equal(visitOutcome(tips, done(), { last: true, current: 1 }).finished, false, "a tip is still waiting");
  assert.equal(visitOutcome(tips, done(), { current: -1 }).finished, false, "only the last chapter finishes");
  assert.equal(visitOutcome([], done(), { last: true, current: -1 }).finished, false, "nothing seen yet");
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

test("on wide windows the dock takes the free rail foot or a panel corner and keeps safety clear", () => {
  // 1920 x 1080 with a short panel: room is left under the rail's safety list.
  const view = {
    vw: 1920, vh: 1080, wide: true, top: 64, rail: box(32, 72, 272, 900), railEnd: 520,
    panel: box(336, 72, 912, 560), columnBottom: 632, footerTop: 572, headerBottom: 180, bottom: 572,
  };
  const list = candidates(view, () => 280);
  const foot = list.find((spot) => spot.left === 32 && spot.top === 532);
  assert.ok(foot, "a spot right under the rail's content");
  const sets = { hard: [], safety: [box(32, 72, 272, 140), box(32, 400, 272, 120)], lead: [], aim: [] };
  assert.equal(placeDock(list, sets, []), foot, "never the rail top over the intro");

  // A shorter window has no room under the rail, so a panel corner it is.
  const short = candidates({ ...view, vh: 720 }, () => 280);
  assert.equal(short.some((spot) => spot.top === 532), false, "the foot spot must fit in the window");
  assert.ok(candidates({ ...view, vh: 816 }, () => 280).some((spot) => spot.left === 32 && spot.top === 528),
    "with little room it sits lower under the content, never closer than 8 px");
  const corner = placeDock(short, sets, []);
  assert.ok(corner && corner.left > view.rail.right, "a panel corner");
  assert.equal(placeDock(short, { ...sets, aim: [corner] }, []), short.find((spot) => spot.left === view.panel.left + 16),
    "the target stays clear when another spot fits");
  assert.equal(placeDock(short, { ...sets, aim: short }, []), null, "covering its own target folds into the chip");
  assert.equal(placeDock(short, { ...sets, aim: short }, [], true), corner, "opened from the chip, it may cover it");
  assert.equal(placeDock(short, { ...sets, safety: short }, []), null, "safety everywhere folds into the chip");
  assert.ok(placeDock(short, { ...sets, safety: short }, [], true), "opened from the chip, it may cover safety last");
});

test("on phones the dock keeps the target, titles, track and warnings clear until the person opens it", () => {
  const view = { vw: 390, vh: 844, wide: false, top: 64, bottom: 772 };
  const [bottom, above, top] = candidates(view, () => 240);
  assert.deepEqual([bottom.top, above.top, top.top], [596, 524, 64]);
  const hard = [box(260, 780, 110, 40)];
  const lead = [box(16, 72, 358, 40), box(16, 180, 300, 36)];
  const aim = [box(16, 560, 358, 60)];
  const list = [bottom, above, top];
  assert.equal(placeDock(list, { hard, safety: [], lead, aim }, []), null,
    "covering the tip's target, the title or the track folds into the chip");
  assert.equal(placeDock(list, { hard, safety: [], lead, aim: [] }, []), above);
  assert.equal(placeDock(list, { hard, safety: [], lead, aim }, [], true), above, "opened from the chip, it may cover the target");
  const warnings = [box(16, 600, 358, 40)];
  assert.equal(placeDock(list, { hard, safety: warnings, lead, aim }, [], true), top, "it covers the title before a warning");
  assert.equal(placeDock(list, { hard, safety: [...warnings, box(16, 120, 358, 40)], lead, aim }, [], true), above,
    "only a hard box is never covered");
  assert.equal(placeDock([bottom], { hard, safety: [], lead: [], aim: [] }, [], true), null);

  // Random layouts: no rule ever covers a hard box, and nothing else until opened.
  let seed = 11;
  const random = (max) => { seed = (seed * 48271) % 2147483647; return seed % max; };
  const rects = () => Array.from({ length: random(3) }, () => box(random(1200), random(700), 20 + random(300), 20 + random(200)));
  for (let round = 0; round < 500; round++) {
    const sets = { hard: rects(), safety: rects(), lead: rects(), aim: rects() };
    const options = Array.from({ length: 1 + random(6) }, () => box(random(1100), random(600), 100 + random(300), 80 + random(300)));
    for (const opened of [false, true]) {
      const chosen = placeDock(options, sets, [], opened);
      if (!chosen) {
        if (opened) assert.ok(options.every((option) => sets.hard.some((rect) => overlaps(option, rect))));
        continue;
      }
      assert.ok(!sets.hard.some((rect) => overlaps(chosen, rect)));
      if (!opened) assert.ok(![...sets.safety, ...sets.lead, ...sets.aim].some((rect) => overlaps(chosen, rect)));
    }
  }
});

test("a target clipped by a scrolled panel body counts as off screen", () => {
  const view = box(0, 56, 1280, 664);
  const body = box(336, 200, 900, 400);
  assert.equal(visiblePart(box(400, 120, 200, 32), [view, body]), null, "scrolled above the body");
  assert.deepEqual(visiblePart(box(400, 300, 200, 32), [view, body]), box(400, 300, 200, 32));
  assert.deepEqual(visiblePart(box(400, 580, 200, 40), [view, body]), box(400, 580, 200, 20), "only the part in view");
  assert.deepEqual(visiblePart(box(400, 700, 200, 40), [view]), box(400, 700, 200, 20), "the window edge cuts it too");
  assert.equal(visiblePart(box(400, 30, 200, 20), [view]), null, "under the top bar it is off screen");
  assert.equal(visiblePart(box(400, 300, 0, 0), [view]), null, "an empty box shows nothing");
});

test("the cursor label never covers a choice's text or a summary", () => {
  const view = { vw: 1280, vh: 720 };
  const size = { arrow: 20, width: 64, height: 20, top: 16 };
  const checkbox = box(360, 400, 18, 18);
  assert.deepEqual(cursorSpot(checkbox, size, view, [box(386, 400, 500, 44)], true),
    { x: 364, y: 412, flip: true, label: true }, "a checkbox is pointed at from its left edge");
  assert.deepEqual(cursorSpot(box(24, 400, 18, 18), size, { vw: 390, vh: 844 }, [box(50, 400, 320, 44)], true),
    { x: 28, y: 412, flip: true, label: false }, "no room on either side leaves the label out");

  const button = box(600, 300, 160, 40);
  assert.deepEqual(cursorSpot(button, size, view, []), { x: 748, y: 334, flip: false, label: true });
  assert.deepEqual(cursorSpot(button, size, view, [box(740, 346, 120, 28)]), { x: 748, y: 334, flip: true, label: true },
    "a summary under the corner sends the label to the other side");
  assert.equal(cursorSpot(box(1180, 300, 90, 40), size, view, []).flip, true, "the window edge flips it as before");
});

test("reduced-motion markers never overlap", () => {
  const [, port] = stackMarkers([box(400, 170, 220, 26), box(560, 170, 180, 26)], 1440);
  assert.deepEqual(port, box(624, 170, 180, 26), "the next marker moves right of the one it hits");
  const [, below] = stackMarkers([box(100, 170, 300, 26), box(200, 170, 200, 26)], 420);
  assert.deepEqual(below, box(200, 200, 200, 26), "a full row sends it under");

  let seed = 5;
  const random = (max) => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let round = 0; round < 300; round++) {
    const width = 320 + random(1600);
    const start = Array.from({ length: 1 + random(8) }, () => box(random(width), random(800), 40 + random(260), 26));
    const placed = stackMarkers(start, width);
    assert.equal(placed.length, start.length);
    placed.forEach((spot, index) => placed.slice(index + 1).forEach((other) => assert.ok(!overlaps(spot, other))));
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
  for (const path of [...paths, "/guide.css", "/guide-dock.css"]) {
    const response = await fetch(`${wizard.origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
  }
});
