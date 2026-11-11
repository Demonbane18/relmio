import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  box, choosePlacement, currentTip, errorInfo, errorTarget, lookupError, overlaps, selectChapter, tipDone, visitOutcome,
} from "../src/ui/guide.js";
import { boundedSpots, candidates, chipSpot, cursorSpot, placeDock, stackMarkers, visiblePart } from "../src/ui/guide-dock.js";
import { startWizardServer } from "../src/web/server.js";

const sessionToken = "guide-engine-test-session-token-0123456789abcdef";
const PAGES = {
  vps: "index.html", local: "local.html", assistant: "assistant.html",
  "supergrok-vps": "supergrok-vps.html", "local-model-vps": "local-model-vps.html", hosting: "hosting.html",
  "claude-vps": "claude-vps.html",
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
    codes: { retryBlocked: entry("flag"), vps_operation_lock: entry("code"), usage_limit: entry("stop"), CACHE_FULL: entry("local") },
    recovery: { reauthorize: entry("recovery"), none: entry("never"), "fix-request": entry("request") },
    status: { 400: entry("bad request"), 401: entry("status") },
    fallback: entry("fallback"),
  };
  const title = (error) => lookupError(errors, error)?.title;
  assert.equal(title({ code: "vps_operation_lock", retryBlocked: true, recovery: "reauthorize", status: 401 }), "flag");
  assert.equal(title({ code: "vps_operation_lock", recovery: "reauthorize", status: 401 }), "code");
  assert.equal(title({ errorCode: "CACHE_FULL", status: 500 }), "local");
  assert.equal(title({ stoppedReason: "usage_limit" }), "stop");
  assert.equal(title({ code: "unknown", recovery: "reauthorize", status: 401 }), "recovery");
  assert.equal(title({ recovery: "none", status: 401 }), "status", "recovery none is skipped");
  assert.equal(title({ retryBlocked: "yes", status: 503 }), "fallback", "flags count only when true");
  assert.equal(title({ code: "constructor", recovery: "toString" }), "fallback", "inherited keys never match");
  assert.equal(lookupError(null, { code: "vps_operation_lock" }), null);

  // The server reports every unclassified failure as a 400 request error, so
  // the advice about a marked box needs a field the error names or the page marked.
  assert.equal(title({ recovery: "fix-request", status: 400 }), "fallback", "no field, no field advice");
  assert.equal(title({ recovery: "fix-request", status: 400, param: "  " }), "fallback", "an empty field name is not a field");
  assert.equal(title({ recovery: "fix-request", status: 400, param: "host" }), "request");
  assert.equal(title({ recovery: "fix-request", status: 400, marked: true }), "request");
  assert.equal(title({ status: 400, marked: true }), "bad request");
  assert.equal(title({ status: 400 }), "fallback");
  assert.equal(title({ status: 400, recovery: "none" }), "fallback");
  assert.equal(title({ status: 400, recovery: "reauthorize" }), "recovery", "another recovery still applies");
  assert.equal(title({ status: 400, code: "vps_operation_lock" }), "code", "a code still wins");
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

  // The step's working controls: never covered until the person opens the dock.
  const other = short.find((spot) => spot.left === view.panel.left + 16);
  assert.equal(placeDock(short, { ...sets, work: [corner] }, []), other, "a field under one corner sends it to the other");
  assert.equal(placeDock(short, { ...sets, work: short }, []), null, "controls under every spot fold it into the chip");
  assert.equal(placeDock(short, { ...sets, work: short }, [], true), corner, "opened from the chip, it may cover them");
  assert.equal(placeDock(short, { ...sets, work: [corner], lead: [other] }, [], true), other,
    "opened, it covers a title before a working control");
  assert.equal(placeDock(short, { ...sets, work: [corner], safety: [...sets.safety, other] }, [], true), corner,
    "and a working control before safety");
});

test("error-help working controls remain clear even in the opened dock's last resort", () => {
  const field = box(16, 160, 300, 40);
  const occupied = box(8, 64, 374, 248);
  const clear = box(8, 220, 374, 160);
  const sets = { hard: [], safety: [], lead: [], aim: [], work: [field], fixed: [field] };
  assert.equal(placeDock([occupied], sets, [], true, [occupied]), null, "a cramped error dock folds instead of covering a field");
  assert.equal(placeDock([occupied], sets, [], true, [clear]), clear, "a clear bounded spot still opens");
});

test("a dock nobody opened shrinks into a clear stretch of the rail column before it folds", () => {
  // 1280 x 720: the rail column holds an intro on top and notes at its foot,
  // and controls fill the panel, so no full-height spot is clear.
  const view = { vw: 1280, vh: 720, wide: true, top: 64, rail: box(32, 72, 272, 620), railEnd: 692,
    panel: box(336, 72, 912, 620), columnBottom: 692, footerTop: 632, headerBottom: 180, bottom: 632 };
  const tall = () => 320;
  const list = candidates(view, tall);
  const intro = box(32, 72, 272, 150);
  const sets = { hard: [], safety: [intro, box(32, 520, 272, 172)], lead: [], aim: [], work: [box(336, 180, 912, 440)] };
  const keep = [...sets.safety, ...sets.work];
  assert.equal(placeDock(list, sets, []), null, "without the stretch it would fold");
  const column = boundedSpots({ ...view, panel: null }, tall, keep, 200);
  assert.ok(column.every((spot) => spot.left === 32 && spot.width === 272), "only the rail column is offered");
  const spot = placeDock(list, sets, [], false, column);
  assert.deepEqual(spot, box(32, 222, 272, 298), "cut to the stretch between the intro and the notes");
  assert.equal(keep.some((rect) => overlaps(spot, rect)), false);

  // A stretch shorter than the least height is not worth a cut dock.
  const crowded = { ...sets, safety: [intro, box(32, 400, 272, 292)] };
  assert.equal(placeDock(list, crowded, [], false,
    boundedSpots({ ...view, panel: null }, tall, [...crowded.safety, ...crowded.work], 200)), null);

  // A stretch that holds the whole dock gives it uncut.
  const roomy = { ...sets, safety: [intro] };
  const whole = placeDock([], roomy, [], false, boundedSpots({ ...view, panel: null }, tall, [...roomy.safety, ...roomy.work], 200));
  assert.equal(whole.height, 320);
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
    const sets = { hard: rects(), safety: rects(), lead: rects(), aim: rects(), work: rects() };
    const options = Array.from({ length: 1 + random(6) }, () => box(random(1100), random(600), 100 + random(300), 80 + random(300)));
    const view = { vw: 1400, vh: 900, wide: true, top: 64, rail: box(32, 72, 272, 700) };
    const keep = [...sets.hard, ...sets.safety, ...sets.lead, ...sets.aim, ...sets.work];
    for (const opened of [false, true]) {
      // Unopened, the spare spots are the rail column's clear stretches.
      const spare = opened ? [] : boundedSpots(view, () => 300, keep, 200);
      const chosen = placeDock(options, sets, [], opened, spare);
      if (!chosen) {
        if (opened) assert.ok(options.every((option) => sets.hard.some((rect) => overlaps(option, rect))));
        continue;
      }
      assert.ok(!sets.hard.some((rect) => overlaps(chosen, rect)));
      if (!opened) assert.ok(!keep.some((rect) => overlaps(chosen, rect)), "nothing it keeps clear is covered, working controls included");
    }
  }
});

test("an opened dock that fits no full-height spot takes one cut to the window instead of folding away", () => {
  // 1280 x 320 with a scrolled page: neither the rail nor the panel has room for the 316 px Help dock.
  const view = { vw: 1280, vh: 320, wide: true, top: 64, rail: box(32, 72, 272, 560), railEnd: 400,
    panel: box(336, 72, 912, 900), columnBottom: 972, footerTop: 912, headerBottom: 180, bottom: 320 };
  const help = () => 316;
  const list = candidates(view, help);
  assert.deepEqual(list, []);
  const hard = [box(32, 100, 272, 40), box(884, 250, 200, 32)];
  const sets = { hard, safety: [], lead: [], aim: [] };
  assert.equal(placeDock(list, sets, []), null, "an unopened dock still folds into the chip");
  const spot = placeDock(list, sets, [], true, boundedSpots(view, help, hard));
  assert.ok(spot, "opened from the chip, it always shows");
  assert.ok(spot.top >= view.top && spot.bottom <= view.vh - 8, "inside the window under the top bar");
  assert.ok(spot.height >= 160 && spot.height < 316, "cut short, so its body scrolls");
  assert.equal(hard.some((rect) => overlaps(spot, rect)), false, "the primary action and kept controls stay clear");

  // A row of kept controls across every column leaves no usable stretch: it
  // covers the fewest of them rather than fold away.
  const row = [box(0, 150, 1280, 60)];
  assert.deepEqual(placeDock(list, { ...sets, hard: row }, [], true, boundedSpots(view, help, row)), box(32, 64, 272, 248));

  // A narrow window with room for two docks tries each half.
  const phone = { vw: 568, vh: 320, wide: false, top: 64, bottom: 320 };
  const actions = [box(52, 194, 230, 80)];
  assert.deepEqual(placeDock(candidates(phone, help), { ...sets, hard: actions }, [], true,
    boundedSpots(phone, help, actions)), box(288, 64, 272, 248));

  // A cut spot that keeps a warning clear comes before a full-height spot over it.
  const tall = box(908, 380, 352, 316);
  const cut = box(336, 64, 352, 248);
  assert.deepEqual(placeDock([tall], { hard: [], safety: [box(900, 400, 300, 60)], lead: [], aim: [] }, [], true, [cut]), cut);

  // Random layouts: an opened dock always shows inside the window, and clear
  // of every hard box whenever one of its spare spots is.
  let seed = 5;
  const random = (max) => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let round = 0; round < 300; round++) {
    const narrow = { vw: 320 + random(700), vh: 300 + random(500), wide: false, top: 64 };
    narrow.bottom = narrow.vh;
    const rects = Array.from({ length: random(4) }, () => box(random(narrow.vw), 64 + random(narrow.vh - 64), 40 + random(300), 30 + random(60)));
    const spare = boundedSpots(narrow, help, rects);
    const chosen = placeDock([], { hard: rects, safety: [], lead: [], aim: [] }, [], true, spare);
    assert.ok(chosen && chosen.top >= narrow.top && chosen.bottom <= narrow.vh - 8 && chosen.left >= 0 && chosen.right <= narrow.vw);
    if (spare.some((option) => !rects.some((rect) => overlaps(option, rect)))) {
      assert.equal(rects.some((rect) => overlaps(chosen, rect)), false);
    }
  }
});

test("the chip stays inside the window and takes the nearest slot that keeps the most clear", () => {
  // 1280 x 320 with a scrolled page: the rail column's foot is below the window.
  const view = { vw: 1280, vh: 320, wide: true, top: 64, rail: box(32, 72, 272, 560), columnBottom: 972, bottom: 320 };
  const none = { hard: [], safety: [], lead: [] };
  assert.deepEqual(chipSpot(view, 93, 44, none, []), box(1171, 260, 93, 44), "the window's foot, not the rail's");
  // Kept controls at both right-hand corners: it stays on that edge, between them.
  const kept = [box(1100, 50, 170, 70), box(1100, 240, 170, 70)];
  assert.deepEqual(chipSpot(view, 93, 44, { ...none, hard: kept }, []), box(1171, 192, 93, 44));
  // Kept controls down the whole right edge: the left edge takes it.
  assert.deepEqual(chipSpot(view, 93, 44, { ...none, hard: [box(1100, 50, 170, 270)] }, []), box(32, 260, 93, 44));
  // A slot that covers neither safety nor a kept control comes before one that covers either.
  const everywhere = [box(0, 240, 1280, 80)];
  const keptTop = [box(1100, 50, 170, 70), box(0, 50, 400, 70)];
  assert.deepEqual(chipSpot(view, 93, 44, { hard: keptTop, safety: everywhere, lead: [] }, []), box(1171, 192, 93, 44));
  // Safety gives way before a working control, and a working control before a kept one.
  const band = [box(0, 124, 1280, 112)];
  assert.deepEqual(chipSpot(view, 93, 44, { hard: keptTop, safety: band, lead: [], work: everywhere }, []), box(1171, 192, 93, 44));
  assert.deepEqual(chipSpot(view, 93, 44, { hard: [...keptTop, ...band], safety: [], lead: [], work: everywhere }, []),
    box(1171, 260, 93, 44));
  // Nothing clear anywhere: it covers the least, at its usual place.
  assert.deepEqual(chipSpot(view, 93, 44, { ...none, hard: [box(0, 0, 1280, 320)] }, []), box(1171, 260, 93, 44));
  // On a wide window the rail column's foot is its usual place; a clear stretch of that column comes before the far edge.
  const wide = { vw: 1280, vh: 720, wide: true, top: 64, rail: box(28, 72, 272, 620), columnBottom: 692, bottom: 632 };
  assert.deepEqual(chipSpot(wide, 216, 44, none, []), box(28, 648, 216, 44));
  const notes = [box(28, 72, 272, 180), box(28, 420, 272, 272)];
  assert.deepEqual(chipSpot(wide, 216, 44, { ...none, safety: notes }, []), box(28, 372, 216, 44),
    "the foot of the stretch between the rail's notes, 4 px clear of them");
  // A panel footer scrolled above the top bar never puts the chip behind it.
  const scrolled = { vw: 390, vh: 844, wide: false, top: 64, bottom: 40 };
  const chip = chipSpot(scrolled, 93, 44, none, []);
  assert.ok(chip.top >= scrolled.top && chip.bottom <= scrolled.vh, "inside the window under the top bar");
});

test("the folded chip never covers a link, a button or a heading while any edge slot is clear of them", () => {
  // /local settings on a 390 x 844 phone with classic scrollbars: the chip used
  // to sit under the top bar, on "Back to dashboard" and the page title.
  const view = { vw: 375, vh: 844, wide: false, top: 64, bottom: 772 };
  const back = box(4, 61, 177, 32);
  const title = box(16, 98, 343, 28);
  const step = box(33, 228, 309, 26);
  const summary = box(33, 262, 309, 50);
  const change = box(260, 330, 77, 32);
  const heading = box(33, 480, 309, 22);
  const container = box(33, 568, 309, 44);
  const network = box(33, 678, 309, 44);
  const footer = [box(33, 796, 90, 40), box(194, 796, 148, 40)];
  const taps = [back, title, step, summary, change, heading, container, network, ...footer];
  const fields = [box(33, 545, 309, 105), box(33, 655, 309, 100)];
  const track = box(44, 135, 286, 36);
  const callout = { ...box(33, 372, 309, 102), weight: 1 };
  const sets = { hard: footer, safety: [], lead: [title, step, track], aim: [], work: [summary, ...fields], taps };
  const clear = (spot, rects) => !rects.some((rect) => overlaps(spot, rect));
  const inside = (spot) => spot.top >= view.top && spot.bottom <= view.vh && spot.left >= 0 && spot.right <= view.vw;

  const spot = chipSpot(view, 216, 44, sets, [callout]);
  assert.ok(inside(spot));
  assert.ok(clear(spot, taps), "no link, button, field control or heading is under it");
  assert.ok(clear(spot, [...sets.work, track]), "nor a field or the quest track");
  assert.deepEqual(spot, box(151, 432, 216, 44), "the free slot nearest its usual place, over plain text only");

  // With the callout gone that slot is empty, so it is taken before any text is covered.
  assert.deepEqual(chipSpot(view, 216, 44, sets, []), box(151, 432, 216, 44));
  // A button in that stretch: the slot above it, between the Change button and the new one.
  const extra = box(200, 440, 120, 32);
  const moved = chipSpot(view, 216, 44, { ...sets, taps: [...taps, extra] }, [callout]);
  assert.ok(inside(moved) && clear(moved, [...taps, extra]));
  // No slot keeps the fields clear: it covers a field's hint before any control or heading.
  const dense = { ...sets, work: [summary, box(33, 320, 309, 440)] };
  const hint = chipSpot(view, 216, 44, dense, [callout]);
  assert.ok(inside(hint) && clear(hint, taps), "controls and headings stay clear when only label and hint text is left");

  // 320 x 640 with a short title: the corner under the top bar touched the Back button by 4 px.
  const small = { vw: 305, vh: 640, wide: false, top: 64, bottom: 568 };
  const short = chipSpot(small, 120, 44, { hard: [], safety: [], lead: [], taps: [back, box(16, 98, 273, 28), box(33, 500, 239, 44)] }, []);
  assert.ok(clear(short, [back]) && short.top >= small.top && short.bottom <= small.vh);

  // Random phone layouts: whenever some edge slot is clear of every tap, the chip is too.
  let seed = 23;
  const random = (max) => { seed = (seed * 48271) % 2147483647; return seed % max; };
  for (let round = 0; round < 400; round++) {
    const phone = { vw: 305 + random(120), vh: 560 + random(320), wide: false, top: 64 };
    phone.bottom = phone.vh - random(90);
    const width = 90 + random(200);
    const buttons = Array.from({ length: 2 + random(9) }, () => box(random(phone.vw - 40), 40 + random(phone.vh - 60), 40 + random(280), 24 + random(40)));
    const text = Array.from({ length: random(5) }, () => ({ ...box(random(200), 64 + random(phone.vh - 100), 100 + random(250), 20 + random(120)), weight: 1 }));
    const chosen = chipSpot(phone, width, 44, { hard: buttons.slice(0, 1), safety: [], lead: [], work: [], taps: buttons }, text);
    assert.ok(chosen.top >= phone.top && chosen.bottom <= phone.vh && chosen.left >= 0 && chosen.right <= phone.vw, "inside the window");
    // Any 44 px band on either edge that no tap reaches (4 px clear) means the chip must be clear of taps.
    const free = [8, phone.vw - 8 - width].some((left) => {
      for (let top = phone.top; top + 44 <= phone.vh - 8; top++) {
        const band = box(left, top - 4, width, 52);
        if (!buttons.some((rect) => overlaps(band, rect))) return true;
      }
      return false;
    });
    if (free) assert.ok(clear(chosen, buttons), `round ${round}: a clear edge slot existed`);
  }
});

test("with no slot clear of them, the chip covers a heading before a link or a button and stays under the top bar", () => {
  // 320 x 640: rows of buttons leave no 44 px gap on either edge, apart from
  // the band of a two-line heading.
  const view = { vw: 320, vh: 640, wide: false, top: 64, bottom: 640 };
  const row = (top, bottom, left = 0, right = 320) => box(left, top, right - left, bottom - top);
  const buttons = [row(60, 110), row(130, 180), row(200, 250), row(350, 400), row(420, 470), row(490, 540), row(560, 640)];
  const heading = row(262, 338, 16, 304);
  const sets = { hard: [], safety: [], lead: [], taps: buttons, headings: [heading] };
  const inside = (spot) => spot.top >= view.top && spot.bottom <= view.vh && spot.left >= 0 && spot.right <= view.vw;
  const clear = (spot, rects) => !rects.some((rect) => overlaps(spot, rect));
  const spot = chipSpot(view, 120, 44, sets, []);
  assert.deepEqual(spot, box(192, 302, 120, 44), "over the heading, on its usual edge");
  assert.ok(inside(spot) && clear(spot, buttons));
  // A button at the heading's right end: the left edge still keeps every button clear.
  const end = row(280, 320, 250, 310);
  assert.deepEqual(chipSpot(view, 120, 44, { ...sets, taps: [...buttons, end] }, []), box(8, 302, 120, 44));
  // A gap clear of buttons and headings alike comes first, even farther from its usual place.
  const gap = buttons.filter((rect) => rect.top !== 130);
  assert.deepEqual(chipSpot(view, 120, 44, { ...sets, taps: gap }, []), box(192, 152, 120, 44), "the gap, not the heading");

  // A button under every slot: it covers as little of them as it can, but never the footer's actions.
  const footer = row(616, 640);
  const rows = [row(60, 110), row(130, 180), row(200, 250), row(270, 320), row(340, 390), row(410, 460), row(480, 530), row(540, 600)];
  const least = chipSpot(view, 120, 44, { hard: [footer], safety: [], lead: [], taps: [...rows, footer] }, []);
  assert.deepEqual(least, box(192, 568, 120, 44), "part of one button, not a whole one and not the footer");
  assert.ok(inside(least) && clear(least, [footer]));
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

test("the cursor label never covers a choice's text, a summary or the text beside its target", () => {
  const view = { vw: 1280, vh: 720 };
  const size = { arrow: 20, width: 64, height: 20, top: 16 };
  const checkbox = box(360, 400, 18, 18);
  assert.deepEqual(cursorSpot(checkbox, size, view, [box(386, 400, 500, 44)], true),
    { x: 364, y: 412, flip: true, raise: false, label: true }, "a checkbox is pointed at from its left edge");
  const phone = { vw: 390, vh: 844 };
  const text = box(50, 400, 320, 44);
  assert.deepEqual(cursorSpot(box(24, 400, 18, 18), size, phone, [text], true),
    { x: 28, y: 406, flip: false, raise: true, label: true }, "no room under it on either side: the label goes above");
  assert.deepEqual(cursorSpot(box(24, 400, 18, 18), size, phone, [text, box(50, 356, 320, 40)], true),
    { x: 28, y: 412, flip: true, raise: false, label: false }, "no clear side leaves the label out");

  const button = box(600, 300, 160, 40);
  assert.deepEqual(cursorSpot(button, size, view, []), { x: 748, y: 334, flip: false, raise: false, label: true });
  assert.deepEqual(cursorSpot(button, size, view, [box(740, 346, 120, 28)]),
    { x: 748, y: 334, flip: true, raise: false, label: true }, "a summary under the corner sends the label to the other side");
  assert.equal(cursorSpot(box(1180, 300, 90, 40), size, view, []).flip, true, "the window edge flips it as before");

  // A full-width field at 1280: the window edge sends the label left, where the hint is.
  const field = box(360, 300, 880, 40);
  const name = box(360, 274, 110, 20);
  assert.deepEqual(cursorSpot(field, size, view, [name, box(360, 346, 300, 18)]),
    { x: 1228, y: 334, flip: true, raise: false, label: true }, "a short hint leaves room under the field's right end");
  assert.deepEqual(cursorSpot(field, size, view, [name, box(360, 346, 880, 18)]),
    { x: 1228, y: 306, flip: true, raise: true, label: true }, "a hint as wide as the field sends the label above it");
  assert.deepEqual(cursorSpot(field, size, view, [box(360, 262, 880, 30), box(360, 346, 880, 18)]),
    { x: 1228, y: 334, flip: false, raise: false, label: false }, "text on every side leaves the label out");
  assert.equal(cursorSpot(box(600, 70, 160, 40), size, { ...view, top: 64 }, [box(500, 110, 400, 40)]).label, false,
    "raised, the label still stays under the top bar");
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
  const paths = ["/guide.js", "/guide-dock.js", "/mascot.js", "/guide/errors.js", "/guide/context.js",
    ...Object.keys(PAGES).map((page) => `/guide/content-${page}.js`)];
  for (const path of [...paths, "/guide.css", "/guide-dock.css"]) {
    const response = await fetch(`${wizard.origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
  }
});
