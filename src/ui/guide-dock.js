// Setup guide dock: screen tracking, the dock and its mascot chip, the pointer,
// Show me, the mascot in the quest track and the badges on Ready screens.
// guide.js imports this module only while the guide or error help is in use,
// so pages with the guide off never load it. The placement helpers are pure
// and exported for tests.
import { ACTION_LABELS, box, choosePlacement, currentTip, errorTarget, overlaps, selectChapter, tipDone, visitOutcome } from "./guide.js";
import { createMascot, setMascotPose } from "./mascot.js";
import { contextualHelp, HELP_FAQ, HELP_TERMS, helpState, UNKNOWN_HELP, validHelpMetadata } from "./guide/context.js";

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
// The rail column: the rail and the blocks the grid places under it, such as
// the safety notes. Their children are its content.
const RAIL = ".rm-split > :not(.rm-split__content, .rm-panel)";
// Page content the dock should avoid covering when it has a choice; covering
// a control costs three times as much as covering text.
const SOFT = `${RAIL} > *, .rm-panel__heading, ${RAIL} :is(button:not(:disabled), a[href], summary),` +
  " .rm-panel__body :is(.rm-field, .rm-check, .rm-choice, .rm-callout, .rm-notice, .rm-card, .rm-dl, .rm-disclosure," +
  " .rm-terminal, .rm-table-wrap, p, h2, h3, li, button, a, label)";
const CONTROLS = "button, a, label, .rm-field, .rm-check, .rm-choice, .rm-disclosure";
// Safety the dock keeps clear: the rail column's content apart from the quest
// track (intros, notes, status and safety lists) and every warning.
const SAFETY = `${RAIL} > *, [data-tone='warning'], .rm-callout--warning, .rm-notice`;
// Also kept clear at first: the page and step titles and the quest track.
const LEAD = "h1, .rm-panel__heading :is(h2, h3), .rm-stepper--track";
// What the person works with in the step: fields, choices, buttons, links,
// disclosures and commands. A dock nobody opened never covers them.
const WORK = ".rm-panel__body :is(input, select, textarea, button, summary, a[href], .rm-field, .rm-check, .rm-choice, .rm-terminal)";
// Text the pointer's action label never covers: choice labels and summaries,
// then every line of text and every control near the target (see beside()).
const LABELS = ":is(.rm-check, .rm-choice) > :not(input), summary";
const CHOICE = "input[type=checkbox], input[type=radio]";
const PRESSABLE = "button, a[href], input, select, textarea, summary";
// What the folded chip keeps clear wherever it sits on the page: every link,
// button, field control, choice and disclosure summary, and every heading.
// With no slot clear of them all, it covers a heading first.
const TAPS = `${PRESSABLE}, .rm-check, .rm-choice`;
const HEADINGS = "h1, h2, h3, h4, h5, h6";
// A dock nobody opened may shrink into a clear stretch of the rail column
// this tall before it folds into the chip.
const SHRUNK = 200;

// Wide screens: the rail column's foot, level with the panel or under its
// content (12 px below it, or as low as the window allows down to 8 px), or
// its top, then corners of the panel above its footer or under its header.
// Narrow screens: a sheet at the bottom of the window, above the panel
// footer, or under the top bar.
export function candidates(view, measure) {
  const list = [];
  if (view.wide && view.rail) {
    const { left, top, width } = view.rail;
    const height = measure(width);
    const foot = Math.min(view.railEnd + 12, view.vh - 8 - height);
    list.push(box(left, view.columnBottom - height, width, height));
    if (foot >= view.railEnd + 8) list.push(box(left, foot, width, height));
    list.push(box(left, top, width, height));
  }
  if (view.wide && view.panel) {
    const width = Math.min(352, view.panel.width - 32);
    const height = measure(width);
    const left = view.panel.right - 16 - width;
    const above = view.footerTop - 12 - height;
    list.push(box(left, above, width, height), box(view.panel.left + 16, above, width, height),
      box(left, view.headerBottom + 8, width, height));
  }
  if (!view.wide) {
    const width = Math.min(view.vw - 16, 512);
    const height = measure(width);
    const left = (view.vw - width) / 2;
    list.push(box(left, view.vh - 8 - height, width, height));
    if (view.bottom < view.vh - 1) list.push(box(left, view.bottom - 8 - height, width, height));
    list.push(box(left, view.top, width, height));
  }
  return list.filter((rect) => rect.top >= view.top - 8 && rect.bottom <= view.vh && rect.left >= 0 && rect.right <= view.vw);
}

// The dock's spot, strictest rule first; null folds it into the chip. It never
// covers the hard boxes (the focused element, the primary action, alerts,
// footer actions and kept controls) where a spot keeps them clear. Until the
// person opens it, it also keeps safety, the step's working controls, the
// titles, the quest track and the tip's target clear; a spare spot cut into a
// clear stretch of the rail column comes before folding. Opened, it gives up
// the target, titles and track first, then the working controls, and safety
// last. At each of those steps a spare spot cut to the window comes before
// giving up more, and on a tiny window it covers the fewest hard boxes.
// Fixed boxes (error-help working controls) are never given up, even there.
export function placeDock(list, { hard, safety, lead, aim, work = [], fixed = [] }, soft, opened = false, spare = []) {
  const required = [...hard, ...fixed];
  const tiers = [[...required, ...safety, ...work, ...lead, ...aim]];
  if (opened) tiers.push([...required, ...safety, ...work], [...required, ...safety], required);
  for (const rects of tiers) {
    for (const spots of [list, spare]) {
      const spot = choosePlacement(spots, rects, soft);
      if (spot) return spot;
    }
  }
  return opened ? choosePlacement(spare, fixed, hard) : null;
}

// The stretches of a column, from `top` down to `floor`, that no stop reaches:
// [top, bottom] pairs in order. `air` keeps that many px clear of each stop.
function clearStretches(left, width, top, floor, stops, air = 0) {
  const found = [];
  const inColumn = stops.filter((rect) => rect.left < left + width && left < rect.right).sort((a, b) => a.top - b.top);
  for (const stop of [...inColumn, box(left, floor + air, width, 0)]) {
    const bottom = Math.min(stop.top - air, floor);
    if (bottom > top) found.push([top, bottom]);
    top = Math.max(top, stop.bottom + air);
  }
  return found;
}

// Spare spots for a dock that fits no full-height spot: its columns cut to
// the window under the top bar, where its body scrolls. A narrow window with
// room for two 272 px docks also tries each half. Each stretch between the
// boxes to keep clear (`stops`) holding at least `least` px comes first, then
// the whole column. An opened dock passes the hard boxes; a dock nobody opened
// passes everything it keeps clear and a view without the panel, so it only
// shrinks into the rail column.
export function boundedSpots(view, measure, stops, least = 160) {
  const columns = [];
  if (view.wide && view.rail) columns.push([view.rail.left, view.rail.width]);
  if (view.wide && view.panel) {
    const width = Math.min(352, view.panel.width - 32);
    columns.push([view.panel.right - 16 - width, width], [view.panel.left + 16, width]);
  }
  if (!columns.length) {
    const width = Math.min(view.vw - 16, 512);
    const half = Math.min(352, (view.vw - 24) / 2);
    columns.push([(view.vw - width) / 2, width]);
    if (half >= 272) columns.push([8, half], [view.vw - 8 - half, half]);
  }
  const floor = view.vh - 8;
  const spots = [];
  for (const [left, width] of columns) {
    const full = measure(width);
    const fit = (top, bottom) => {
      const height = Math.min(full, bottom - top);
      return [box(left, top, width, height), box(left, bottom - height, width, height)];
    };
    for (const [top, bottom] of clearStretches(left, width, view.top, floor, stops)) {
      if (bottom - top >= Math.min(full, least)) spots.push(...fit(top, bottom));
    }
    spots.push(...fit(view.top, floor));
  }
  return spots;
}

// The chip takes the slot nearest its usual place that keeps the most clear.
// Its usual place is the rail column's foot on wide windows, else the right
// edge above the panel footer, at the window's foot or under the top bar.
// Slots are those corners, the left edge's corners and both ends of every
// clear stretch down the window's left and right edges, always inside the
// window under the top bar. Plain text may sit under it. It keeps everything
// else clear, then gives up the tip's target and the quest track, then safety
// notes, then a field's label or hint. A link, a button, a field's control, a
// choice (`taps`) or a heading is covered only when no slot on either edge
// keeps them all clear: a heading first, then the least of the rest, and a
// hard box last of all.
export function chipSpot(view, width, height, { hard, safety, lead, aim = [], work = [], taps = [], headings = [] }, soft = []) {
  const gap = view.wide ? 16 : 8;
  const at = (left, top) => box(left, top, width, height);
  const right = view.vw - gap - width;
  const left = view.rail?.left ?? gap;
  const floor = view.vh - gap;
  const inside = (spots) => spots.filter((rect) =>
    rect.top >= view.top && rect.bottom <= view.vh && rect.left >= 0 && rect.right <= view.vw);
  const corners = inside([...(view.rail ? [at(left, view.columnBottom - height)] : []),
    at(right, view.bottom - gap - height), at(right, floor - height), at(right, view.top),
    at(left, floor - height), at(left, view.top)]);
  const home = corners[0] ?? at(right, view.top);
  // The corners, then both ends of each stretch of an edge that the boxes leave clear by 4 px.
  const slots = (rects) => [...corners, ...inside([...new Set([right, left])].flatMap((edge) =>
    clearStretches(edge, width, view.top, floor, rects, 4).flatMap(([top, bottom]) =>
      (bottom - top < height ? [] : [at(edge, top), at(edge, bottom - height)]))))];
  const base = [...hard, ...taps, ...headings];
  const tiers = [
    [...base, ...work, ...safety, ...lead, ...aim],
    [...base, ...work, ...safety],
    [...base, ...work],
    base,
    [...hard, ...taps],
  ];
  for (const rects of tiers) {
    let best = null;
    let least = Infinity;
    for (const spot of slots(rects)) {
      if (rects.some((rect) => overlaps(spot, rect))) continue;
      const far = Math.hypot(spot.left - home.left, spot.top - home.top);
      if (far < least) [best, least] = [spot, far];
    }
    if (best) return best;
  }
  const last = slots(hard);
  const weighed = [...taps.map((rect) => ({ ...box(rect.left, rect.top, rect.width, rect.height), weight: 4 })), ...headings, ...soft];
  return choosePlacement(last, hard, weighed) ?? choosePlacement(last, [], hard) ?? home;
}

// The part of a box inside every clip box, or null when none of it shows.
export function visiblePart(rect, clips) {
  let { left, top, right, bottom } = rect;
  for (const clip of clips) {
    [left, top] = [Math.max(left, clip.left), Math.max(top, clip.top)];
    [right, bottom] = [Math.min(right, clip.right), Math.min(bottom, clip.bottom)];
  }
  return right > left && bottom > top ? box(left, top, right - left, bottom - top) : null;
}

// The pointer's cursor: its tip on the target's bottom right, or on a
// checkbox or radio's left edge so the action label points away from its
// text. The label sits under the target beside the arrow. When it would leave
// the window or cover an avoided box it takes the other side, then the same
// two sides above the target with the cursor on the top edge (`raise`). It is
// left out when no side is clear.
export function cursorSpot(goal, { arrow, width, height, top }, view, avoid, control = false) {
  const x = control ? goal.left + 4 : Math.min(goal.right - 12, view.vw - 24);
  const low = Math.min(goal.bottom - 6, view.vh - 32);
  const sides = control ? [true, false] : [false, true];
  for (const raise of [false, true]) {
    const y = raise ? goal.top + 6 : low;
    for (const flip of sides) {
      const label = box(flip ? x - arrow - width : x + arrow, raise ? y - top - height : y + top, width, height);
      if (label.left >= 8 && label.right <= view.vw - 8 && label.top >= (view.top ?? 0) && label.bottom <= view.vh &&
          !avoid.some((rect) => overlaps(label, rect))) return { x, y, flip, raise, label: true };
    }
  }
  return { x, y: low, flip: sides[0], raise: false, label: false };
}

// Show me markers under reduced motion: each starts above its target and moves
// right past a marker it would overlap, or under it when the row is full.
export function stackMarkers(boxes, width) {
  const placed = [];
  for (const start of boxes) {
    let spot = start;
    for (let hit; (hit = placed.find((other) => overlaps(spot, other)));) {
      spot = hit.right + 4 + spot.width <= width ? box(hit.right + 4, spot.top, spot.width, spot.height)
        : box(start.left, hit.bottom + 4, spot.width, spot.height);
    }
    placed.push(spot);
  }
  return placed;
}

export function mountGuide(host) {
  const doc = document;
  const { page, toggles } = host;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = -1; let tipIndex = -1; let viewTip = null; let finished = false; let happyUntil = 0;
  // viewTip was chosen by focus, not by Back or Next tip: the dock shows the
  // tip of the control the person is using while that control keeps focus.
  let followed = false;
  let visitShown = new Set(); let visitDone = new Set();
  const marks = new Set(); const completed = new Set(); const earned = [];
  // A press counts once its operation ends without a new failure: each pressed
  // tip waits here with the failure that was showing at the press. A chapter
  // left while a press waits or the page is busy earns its badge afterwards.
  const pending = new Map(); const departed = new Map();
  let hidden = false; let seenPref; let returnFocus = null; let restored = false;
  let demo = null; let demoTip = null; let markers = []; let look = {};
  let frame = 0; let placeFrame = 0; let shownKey = ""; let observedTarget = null;
  // The next placement follows a scroll or a resize, so nothing fades in.
  let drift = false;
  // The dock content the person asked to see (the chip, Start the guide, Back
  // or Next tip); "next" until it renders. Only that content, or a dock holding
  // focus, may cover the page past the strict rules.
  let openedKey = null;
  let helpOpen = false; let helpSelection = "";
  const PROGRESS = `relmio-guide-progress:${page}`;
  const busy = () => doc.body.dataset.operationBusy === "true";

  const all = (selector) => { try { return [...doc.querySelectorAll(selector)]; } catch { return []; } };
  const owned = (node) => toggles.includes(node) || ui.layer.contains(node) || ui.track.contains(node) ||
    Boolean(ui.finish?.contains(node)) || node === ui.jump;
  const showing = (node) => (node.checkVisibility ? node.checkVisibility() : node.getClientRects().length > 0);
  const visible = (node) => Boolean(node) && !ui.layer.contains(node) && showing(node);
  const first = (selector) => (typeof selector === "string" ? all(selector).find(visible) ?? null : null);
  const shown = (selector) => first(selector) !== null;
  // Boxes of the nodes on screen, leaving out visually hidden ones.
  const boxes = (nodes) => nodes.filter(visible).map((node) => node.getBoundingClientRect())
    .filter((rect) => rect.width > 1 && rect.height > 1);
  const matches = (node, selector) => { try { return Boolean(node?.closest?.(selector)); } catch { return false; } };
  // A copy button: a page's copy target or a button with the kit's copy icon.
  const copyButton = (node) => (node.matches("[data-copy-target]") || node.querySelector(".rm-icon--copy") ? node : null);
  const attr = (node, name, value) => { if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
  const make = (tag, className = "", text = "") => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const textButton = (className, text = "") => Object.assign(make("button", className, text), { type: "button" });
  const iconButton = (icon, label, variant = "") => {
    const node = textButton(`rm-icon-button rm-icon-button--sm ${variant}`.trim());
    node.setAttribute("aria-label", label);
    node.title = label;
    const glyph = make("span", `rm-icon rm-icon--${icon} rm-icon--sm`);
    glyph.setAttribute("aria-hidden", "true");
    node.append(glyph);
    return node;
  };
  const probe = (chapter) => ({
    shown,
    // Read validity first: invalid inputs must not fire the page's "invalid"
    // handler merely because the guide evaluated them.
    filled: (selector) => all(selector).some((node) => visible(node) && String(node.value ?? "").trim() !== "" &&
      node.validity?.valid !== false && node.checkValidity?.() !== false),
    checked: (selector) => all(selector).some((node) => node.checked === true || Boolean(node.querySelector?.("input:checked"))),
    marked: (tip, kind) => marks.has(`${kind}|${chapter.id}/${tip.id}`),
  });
  const chapterNow = () => host.content?.chapters[active];

  const ui = build();

  function build() {
    const layer = make("div", "rm-guide-layer");
    const dock = make("aside", "rm-guide");
    dock.setAttribute("aria-label", "Setup guide");
    dock.id = "relmio-help-dock";
    dock.tabIndex = -1;
    const head = make("div", "rm-guide__head");
    const face = make("span", "rm-guide__mascot");
    const mascot = createMascot();
    face.append(mascot);
    const quest = make("div", "rm-guide__quest");
    const eyebrow = make("p", "rm-guide__eyebrow");
    const progress = make("div", "rm-guide__progress");
    const dots = make("ol", "rm-guide__dots");
    dots.setAttribute("aria-hidden", "true");
    progress.append(dots);
    quest.append(eyebrow, progress);
    const hide = iconButton("chevron-down", "Hide guide");
    const close = iconButton("x", "Skip guide");
    head.append(face, quest, hide, close);
    const live = make("div", "rm-guide__live");
    const title = make("p", "rm-guide__title");
    const say = make("p", "rm-guide__say");
    const steps = make("ol", "rm-guide__steps");
    steps.setAttribute("aria-label", "Next steps");
    live.append(title, say, steps);
    const example = make("p", "rm-guide__example", "Example ");
    const code = make("code");
    example.append(code);
    const find = make("details", "rm-disclosure rm-disclosure--plain rm-guide__find");
    const findBody = make("div", "rm-disclosure__body");
    const findText = make("p");
    findBody.append(findText);
    find.append(make("summary", "", "Where do I find this?"), findBody);
    const next = make("ul", "rm-guide__next");
    const topics = make("label", "rm-field rm-guide__topics");
    const topicLabel = make("span", "rm-field__label", "Help topic");
    const topic = make("select", "rm-select");
    topics.append(topicLabel, topic);
    const availability = make("p", "rm-small rm-muted rm-guide__availability");
    const about = make("details", "rm-disclosure rm-disclosure--plain rm-guide__find");
    const aboutBody = make("div", "rm-disclosure__body");
    const source = make("p", "rm-small rm-muted");
    aboutBody.append(source);
    about.append(make("summary", "", "About this help"), aboutBody);
    const actions = make("div", "rm-guide__actions");
    const back = iconButton("arrow-left", "Back", "rm-icon-button--outline");
    const forward = textButton("rm-button rm-button--sm", "Next tip");
    const show = textButton("rm-button rm-button--sm", "Show me");
    const start = textButton("rm-button rm-button--sm", "Start the guide");
    const skip = textButton("rm-button rm-button--ghost rm-button--sm", "Skip guide");
    const help = textButton("rm-button rm-button--ghost rm-button--sm", "Help");
    actions.append(back, forward, show, help, start, skip);
    // Cut to a short window, only the body scrolls; the head and actions stay.
    const body = make("div", "rm-guide__body");
    body.append(topics, live, example, find, next, availability, about);
    dock.append(head, body, actions);
    const chip = textButton("rm-guide-chip");
    const chipFace = make("span", "rm-guide-chip__mascot");
    const chipMascot = createMascot();
    chipFace.append(chipMascot);
    const chipText = make("span");
    chip.append(chipFace, chipText);
    chip.setAttribute("aria-controls", "relmio-help-dock");
    chip.setAttribute("aria-expanded", "false");
    const pointer = make("div", "rm-guide-pointer");
    pointer.setAttribute("aria-hidden", "true");
    const ring = make("div", "rm-guide-pointer__ring");
    const cursor = make("div", "rm-guide-pointer__cursor");
    const label = make("span", "rm-guide-pointer__label");
    cursor.append(make("span", "rm-guide-pointer__arrow"), label);
    pointer.append(ring, cursor);
    // One polite status for every tip, outside the dock, so tips are also
    // announced while the dock is folded into the chip.
    const announce = make("p", "rm-visually-hidden");
    announce.setAttribute("role", "status");
    dock.hidden = chip.hidden = pointer.hidden = true;
    layer.append(pointer, dock, chip, announce);
    doc.body.append(layer);
    // The dock is last in the page, so a second skip link reaches it first.
    const jump = Object.assign(make("a", "rm-skip-link", "Skip to setup guide"), { href: "#relmio-help-dock" });
    jump.setAttribute("data-guide-help", "");
    jump.addEventListener("click", (event) => { event.preventDefault(); focusDock(); });
    doc.querySelector(".rm-skip-link")?.after(jump);
    // A tighter view box for the quest track; the cap and warning mark may spill.
    const track = createMascot();
    track.setAttribute("viewBox", "-6 -6 108 138");
    const finish = doc.querySelector("[data-guide-finish]");

    const collapse = () => {
      hidden = true; helpOpen = false; openedKey = null;
      stopDemo(); clearMarkers(); refresh();
    };
    // Focus moves to the visible guide toggle, or the menu that holds it.
    const turnOff = () => {
      helpOpen = false;
      stopDemo(); clearMarkers();
      host.choose("off");
      (toggles.find((node) => node.checkVisibility?.()) ?? doc.querySelector(".rm-menu > summary"))?.focus();
    };
    hide.addEventListener("click", () => { collapse(); chip.focus(); });
    close.addEventListener("click", turnOff);
    skip.addEventListener("click", turnOff);
    start.addEventListener("click", () => {
      helpOpen = false; openedKey = "next";
      if (host.pref !== "on") host.choose("on");
      refresh(); focusDock();
    });
    back.addEventListener("click", () => { if (back.getAttribute("aria-disabled") !== "true") step(-1); });
    forward.addEventListener("click", () => { if (forward.getAttribute("aria-disabled") !== "true") step(1); });
    show.addEventListener("click", showMe);
    // With the walkthrough on, the chip is the folded guide: it carries the
    // current tip's title and opens that tip. Otherwise it opens Help.
    chip.addEventListener("click", () => {
      if (!walk()) return openHelp();
      returnFocus = doc.activeElement;
      hidden = false; openedKey = "next";
      refresh(); focusDock();
    });
    help.addEventListener("click", openHelp);
    topic.addEventListener("change", () => {
      helpSelection = topic.value; followed = false;
      stopDemo(); clearMarkers(); openedKey = "next"; refresh();
    });
    dock.addEventListener("focusin", (event) => { if (!dock.contains(event.relatedTarget)) returnFocus = event.relatedTarget; });
    dock.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const origin = returnFocus;
      collapse();
      (origin?.isConnected && visible(origin) ? origin : chip).focus();
    });
    return { layer, dock, mascot, eyebrow, progress, dots, close, title, say, steps, example, code, find, findText,
      next, topics, topic, availability, about, source, actions, back, forward, show, help, start, skip,
      chip, chipMascot, chipText, pointer, ring, cursor, label, track, finish, announce, jump };
  }

  function openHelp() {
    returnFocus = doc.activeElement;
    hidden = false; helpOpen = true; helpSelection = ""; openedKey = "next"; followed = false;
    stopDemo(); clearMarkers(); refresh(); focusDock();
  }

  function helpEntry() {
    if (!validHelpMetadata(host.content?.metadata)) return UNKNOWN_HELP;
    const tips = chapterNow()?.tips ?? [];
    if (helpSelection.startsWith("tip:")) return tips.find((tip) => `tip:${tip.id}` === helpSelection) ?? UNKNOWN_HELP;
    if (helpSelection.startsWith("faq:")) return HELP_FAQ.find((item) => `faq:${item.id}` === helpSelection) ?? UNKNOWN_HELP;
    if (helpSelection.startsWith("term:")) return HELP_TERMS.find((item) => `term:${item.id}` === helpSelection) ?? UNKNOWN_HELP;
    if (host.failure?.entry) return { ...host.failure.entry, id: "error", target: errorTarget(host.failure.entry, host.failure.info, page) };
    const root = all(".siwc-controls").find(visible);
    // A causal permission rule applies only while its account controls are on screen.
    const cause = contextualHelp(helpState(root, doc.body), host.content.metadata);
    return cause ?? tips[tipIndex] ?? UNKNOWN_HELP;
  }

  function focusDock() {
    (ui.dock.hidden ? ui.chip : ui.dock).focus();
  }

  // The walkthrough view the chip stands for: null with the guide off, with no
  // content or while an error needs help.
  function walk() {
    const { pref, content, failure } = host;
    return failure?.entry || !content || pref === "off" ? null : pref === null ? "welcome" : finished ? "finish" : "guide";
  }

  function mode() {
    if (host.pref !== seenPref) [seenPref, hidden] = [host.pref, false];
    if (helpOpen) return "help";
    if (hidden) return "chip";
    if (host.failure?.entry) return host.pref === "off" ? "chip" : "error";
    return walk() ?? "chip";
  }

  // Reading tips passed with Next tip and the badges earned stay for this tab,
  // so a reload does not bring them back. Only ids this page's content knows
  // are taken. Presses and field values are page state, read from the page.
  function restore() {
    if (restored) return;
    restored = true;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(PROGRESS)); } catch {}
    const read = Array.isArray(saved?.read) ? saved.read : [];
    const badges = Array.isArray(saved?.badges) ? saved.badges : [];
    for (const chapter of host.content.chapters) {
      for (const tip of chapter.tips) {
        if (tip.done === "manual" && read.includes(`${chapter.id}/${tip.id}`)) marks.add(`manual|${chapter.id}/${tip.id}`);
      }
      if (!badges.includes(chapter.id) || completed.has(chapter.id)) continue;
      completed.add(chapter.id);
      if (chapter.badge) earned.push(chapter.badge);
    }
  }

  function keep() {
    try {
      sessionStorage.setItem(PROGRESS, JSON.stringify({
        read: [...marks].filter((key) => key.startsWith("manual|")).map((key) => key.slice(7)),
        badges: [...completed],
      }));
    } catch {}
  }

  // One hop of the mascot.
  function cheer() {
    happyUntil = performance.now() + 320;
    setTimeout(schedule, 350);
  }

  function award(chapter) {
    if (!chapter || completed.has(chapter.id)) return;
    completed.add(chapter.id);
    if (chapter.badge) earned.push(chapter.badge);
    keep();
    cheer();
  }

  function evaluate() {
    const failure = host.failure;
    if (failure?.surfaces.length && !failure.surfaces.some(visible)) host.failure = null;
    const chapters = host.content?.chapters;
    if (!chapters) return;
    restore();
    // A press counts once the page is idle again and reported no new failure.
    // A copy button's press counts once the page marks a successful copy with
    // data-copied, so a copy the browser is still asking about or refused
    // leaves its tip open.
    let installed = false;
    for (const [key, press] of pending) {
      if ((host.failureCount ?? 0) !== press.failureCount || (host.failure && host.failure !== press.failure)) pending.delete(key);
      else if (press.copy ? press.copy.hasAttribute("data-copied") : !busy()) {
        marks.add(key);
        pending.delete(key);
        installed ||= press.tip.installs === true;
      }
    }
    // A newly issued key needs its own copy, even after an earlier key's tip
    // was completed. Forget that press when its fresh-key control leaves view.
    for (const chapter of chapters) for (const tip of chapter.tips) {
      if (tip.done === "clicked" && tip.target.includes("[data-guide-state=fresh]") && !shown(tip.target)) {
        marks.delete(`clicked|${chapter.id}/${tip.id}`);
      }
    }
    const outcome = (chapter, visit, current) => {
      const check = probe(chapter);
      return visitOutcome([...visit.shown], (tip) => visit.done.has(tip) || tipDone(tip, check),
        { last: chapter === chapters.at(-1), current });
    };
    const index = selectChapter(chapters, shown);
    if (index !== active) {
      if (chapters[active]) departed.set(chapters[active], { shown: visitShown, done: visitDone });
      [active, viewTip, followed, finished, visitShown, visitDone] = [index, null, false, false, new Set(), new Set()];
      stopDemo();
      clearMarkers();
      helpSelection = "";
    }
    // A chapter left behind earns its badge once the page is idle and no
    // press there still waits for its result.
    for (const [chapter, visit] of departed) {
      if (busy() || [...pending.values()].some((press) => press.chapter === chapter)) continue;
      departed.delete(chapter);
      if (outcome(chapter, visit).badge) award(chapter);
    }
    // A real install that reaches the Ready step gets one hop, badge or not.
    if (installed && active === chapters.length - 1) cheer();
    const chapter = chapters[active];
    if (!chapter) { tipIndex = -1; return; }
    const check = probe(chapter);
    for (const tip of chapter.tips) {
      if (!shown(tip.target)) continue;
      visitShown.add(tip);
      if (tipDone(tip, check)) visitDone.add(tip);
    }
    const current = currentTip(chapter.tips, check);
    if (current >= 0) finished = false;
    if (viewTip && viewTip.base !== current) {
      // A tip chosen by focus stays while its control keeps focus.
      if (followed && matches(doc.activeElement, chapter.tips[viewTip.index]?.target)) viewTip.base = current;
      else [viewTip, followed] = [null, false];
    }
    tipIndex = viewTip?.index ?? (current >= 0 ? current : chapter.tips.findLastIndex((tip) => shown(tip.target)));
    const result = finished ? null : outcome(chapter, { shown: visitShown, done: visitDone }, current);
    if (result?.finished) {
      finished = true;
      if (result.badge) award(chapter);
    }
  }

  function step(delta) {
    const chapter = chapterNow();
    const tips = chapter?.tips ?? [];
    const tip = tips[tipIndex];
    if (!tip) return;
    if (delta > 0 && tip.done === "manual") {
      marks.add(`manual|${chapter.id}/${tip.id}`);
      keep();
    }
    let index = tipIndex + delta;
    while (tips[index] && !shown(tips[index].target)) index += delta;
    viewTip = tips[index] ? { index, base: currentTip(tips, probe(chapter)) } : null;
    followed = false;
    openedKey = "next";
    refresh();
  }

  // The dock follows the control the person is using: its tip shows while it
  // keeps focus, and Help switches to that tip's topic.
  function follow(event) {
    placeSoon();
    if (owned(event.target) || demo) return;
    const chapter = chapterNow();
    const tips = chapter?.tips ?? [];
    const index = event.type === "focusin" ? tips.findIndex((tip) => shown(tip.target) && matches(event.target, tip.target)) : -1;
    if (index >= 0 && helpOpen) [helpSelection, viewTip, followed] = [`tip:${tips[index].id}`, null, true];
    else if (index >= 0) [viewTip, followed] = [{ index, base: currentTip(tips, probe(chapter)) }, true];
    else if (followed) [viewTip, followed, helpSelection] = [null, false, ""];
    else return;
    schedule();
  }

  const sentence = (text) => (/[.?]$/u.test(text) ? text : `${text}.`);

  function render() {
    const current = mode();
    const content = host.content;
    const chapter = chapterNow();
    // Hide and automatic folding keep the walkthrough available to the one
    // status region; switching it off stops walkthrough announcements.
    const display = current === "chip" && host.pref === "on"
      ? host.failure?.entry ? "error" : walk() ?? "chip" : current;
    const tip = display === "guide" ? chapter?.tips[tipIndex] : null;
    const entry = current === "help" ? helpEntry() : host.failure?.entry;
    const goal = target(current);
    const missing = current === "help" && entry.target && !goal;
    const availability = missing ? "This control is not visible in this view. Choose Current step or open the relevant section to find it." : "";
    const key = `${display}|${display === "guide" ? `${chapter?.id}/${tip?.id}` : ["error", "help"].includes(display) ? `${entry?.id}/${entry?.title}/${entry?.say}/${Boolean(missing)}` : ""}`;
    if (openedKey === "next" && current !== "chip") openedKey = key;
    const focusInside = ui.dock.contains(doc.activeElement);
    // A Ready screen with the badges block lists them, so the dock does not repeat them.
    const listed = onPage(content);
    if (key !== shownKey && display !== "chip") {
      shownKey = key;
      const [title, say] = ["error", "help"].includes(display) ? [entry.title, entry.say]
        : display === "finish" ? [content.finish?.title ?? "Setup complete", content.finish?.say]
          : tip ? [tip.title, tip.say] : [content.title, content.intro];
      const steps = ["error", "help"].includes(display) ? entry.steps ?? [] : [];
      ui.title.textContent = title ?? "";
      ui.say.textContent = say ?? "";
      ui.steps.replaceChildren(...steps.map((text) => make("li", "", text)));
      // Announced once from the status region; a change that follows focus
      // announces the tip's title only.
      ui.announce.textContent = followed && ["guide", "help"].includes(display) ? title ?? ""
        : [title, say, ...steps, availability].filter(Boolean).map(sentence).join(" ");
      ui.code.textContent = (current === "help" ? entry : tip)?.example ?? "";
      ui.findText.textContent = (current === "help" ? entry : tip)?.find ?? "";
      ui.find.open = false;
      ui.next.replaceChildren(...(current === "finish" && !listed ? content.finish?.next ?? [] : [])
        .map((text) => make("li", "", text)));
    }
    // A quest takes the number of the page's current step, so the dock agrees
    // with the quest track; a page without a track counts its chapters.
    const item = content ? first(".rm-stepper__item[aria-current='step']") : null;
    const quest = item ? [...item.parentElement.children].indexOf(item) + 1 : active + 1;
    const eyebrow = current === "help" ? "Help for this view" : current === "error" ? "Error help" : current === "guide" && chapter
      ? `Quest ${quest} · ${chapter.label}` : "Setup guide";
    if (current !== "chip" && ui.eyebrow.textContent !== eyebrow) ui.eyebrow.textContent = eyebrow;
    const chapters = current === "error" ? [] : content?.chapters ?? [];
    if (ui.dots.children.length !== chapters.length) {
      ui.dots.replaceChildren(...chapters.map(() => {
        const dot = make("li");
        dot.addEventListener("animationend", () => dot.classList.remove("is-new"));
        return dot;
      }));
    }
    chapters.forEach((item, index) => {
      const dot = ui.dots.children[index];
      const state = completed.has(item.id) ? "done" : index === active && current === "guide" ? "current" : "todo";
      // A dot that turns done while the guide runs draws its check once.
      if (state === "done" && !["done", null].includes(dot.getAttribute("data-state"))) dot.classList.add("is-new");
      attr(dot, "data-state", state);
    });
    const badges = current === "finish" ? (listed ? [] : earned) : current === "guide" ? earned.slice(-1) : [];
    const chips = [...ui.progress.children].slice(1);
    if (chips.length !== badges.length || chips.some((node, index) => node.textContent !== badges[index])) {
      ui.progress.replaceChildren(ui.dots, ...badges.map((text) => make("span", "rm-badge rm-badge--success", text)));
    }
    const tips = tip ? chapter.tips : [];
    const before = tips.slice(0, tipIndex).some((item) => shown(item.target));
    const after = tips.slice(tipIndex + 1).some((item) => shown(item.target)) ||
      (tip?.done === "manual" && !marks.has(`manual|${chapter.id}/${tip.id}`));
    ui.steps.hidden = !ui.steps.children.length;
    ui.example.hidden = !ui.code.textContent;
    ui.find.hidden = !ui.findText.textContent;
    ui.next.hidden = !ui.next.children.length;
    ui.progress.hidden = current === "error" || current === "help";
    ui.topics.hidden = ui.about.hidden = current !== "help";
    if (current === "help") {
      // Current step, then the visible tips, the questions and the words.
      const groups = [
        ["This step", (chapter?.tips ?? []).filter((item) => shown(item.target)).map((item) => [`tip:${item.id}`, item.title])],
        ["Questions", HELP_FAQ.map((item) => [`faq:${item.id}`, item.title])],
        ["Words", HELP_TERMS.map((item) => [`term:${item.id}`, item.title])],
      ].filter(([, options]) => options.length);
      const option = ([value, title]) => Object.assign(make("option", "", title), { value });
      const signature = groups.flatMap(([, options]) => options.map(([value]) => value)).join("|");
      if (ui.topic.dataset.options !== signature) {
        ui.topic.replaceChildren(option(["", "Current step"]), ...groups.map(([label, options]) => {
          const group = Object.assign(make("optgroup"), { label });
          group.append(...options.map(option));
          return group;
        }));
        ui.topic.dataset.options = signature;
      }
      ui.topic.value = helpSelection;
      const meta = host.content?.metadata;
      ui.source.textContent = validHelpMetadata(meta)
        ? `Bundled help revision ${meta.revision}, source Relmio ${meta.sourceVersion}, reviewed ${meta.reviewedOn}. Sources: ${meta.sources.join(", ")}. Help runs on this computer without model requests or a question history.`
        : "Help metadata is unavailable or unsupported. Follow the current view's instructions and documentation.";
    }
    attr(ui.dock, "aria-label", current === "help" ? "Help" : current === "error" ? "Error help" : "Setup guide");
    ui.back.hidden = ui.forward.hidden = ui.close.hidden = current !== "guide";
    attr(ui.back, "aria-disabled", String(!before));
    attr(ui.forward, "aria-disabled", String(!after));
    ui.availability.textContent = availability;
    ui.availability.hidden = !missing;
    ui.show.hidden = !goal;
    ui.help.hidden = current === "help" || current === "chip";
    ui.start.hidden = current !== "welcome" && current !== "help";
    ui.start.textContent = current === "help" && host.pref === "on" ? "Return to guide" : "Start the guide";
    ui.skip.hidden = current !== "welcome";
    ui.actions.hidden = [...ui.actions.children].every((node) => node.hidden);
    // While the walkthrough is on, the chip is the folded guide and carries
    // the current tip's title; the skip link names where it leads.
    const resume = walk();
    const chipTitle = host.failure?.entry ? "Need help with this error?"
      : resume === "guide" ? chapter?.tips[tipIndex]?.title ?? "Setup guide"
        : resume === "finish" ? content.finish?.title ?? "Setup complete" : resume ? "Setup guide" : "Help";
    if (ui.chipText.textContent !== chipTitle) ui.chipText.textContent = chipTitle;
    attr(ui.chip, "aria-label", host.failure?.entry ? chipTitle : !resume ? "Open help for this view"
      : chipTitle === "Setup guide" ? "Open the setup guide" : `Setup guide: ${chipTitle}`);
    attr(ui.chip, "aria-expanded", String(current === "help"));
    const jump = content && host.pref !== "off" ? "Skip to setup guide" : "Skip to help";
    if (ui.jump.textContent !== jump) ui.jump.textContent = jump;
    const happy = performance.now() < happyUntil;
    setMascotPose(ui.chipMascot, happy ? "happy" : host.failure?.entry ? "worried" : "idle");
    const pose = happy ? "happy" : current === "error" ? "worried"
      : tip?.action === "wait" || entry?.id === "busy" ? "waiting" : tip?.action === "read" ? "thinking"
        : tip || (current === "help" && goal) ? "look" : "idle";
    setMascotPose(ui.mascot, pose, look);
    // Relmio stands in the quest track's current step while the guide is on.
    const step = host.pref === "on" ? item?.querySelector(".rm-stepper__marker") : null;
    if (!step) ui.track.remove();
    else if (ui.track.parentNode !== step) step.append(ui.track);
    setMascotPose(ui.track, pose === "look" ? "idle" : pose);
    renderFinish(content);
    if (focusInside && !showing(doc.activeElement)) ui.dock.focus();
  }

  // Ready screens list the badges earned so far and the page's next steps
  // while the guide is on and the last chapter is on screen.
  function onPage(content) {
    const chapters = content?.chapters ?? [];
    return Boolean(ui.finish) && host.pref === "on" && chapters.length > 0 && active === chapters.length - 1;
  }

  function renderFinish(content) {
    const block = ui.finish;
    const show = onPage(content);
    if (block && block.hidden !== !show) block.hidden = !show;
    if (!show) return;
    const badges = block.querySelector("[data-guide-badges]");
    if (badges && [...badges.children].map((node) => node.textContent).join("\n") !== earned.join("\n")) {
      badges.replaceChildren(...earned.map((text) => make("li", "rm-badge rm-badge--success", text)));
    }
    if (badges?.parentElement) badges.parentElement.hidden = !earned.length;
    const next = block.querySelector("[data-guide-next]");
    if (next && !next.children.length) next.replaceChildren(...(content.finish?.next ?? []).map((text) => make("li", "", text)));
  }

  function target(current = mode()) {
    if (current === "help") return first(helpEntry().target);
    if (current === "error") {
      return first(errorTarget(host.failure.entry, host.failure.info, page)) ?? first("[aria-invalid='true']");
    }
    const tip = demoTip ?? (current === "guide" ? chapterNow()?.tips[tipIndex] : null);
    return tip ? first(tip.target) : null;
  }

  function layout() {
    const vw = doc.documentElement.clientWidth;
    const vh = innerHeight;
    const wide = matchMedia("(min-width: 64rem)").matches;
    const top = (doc.querySelector(".rm-topbar")?.getBoundingClientRect().bottom ?? 0) + 8;
    const rail = wide ? first(".rm-split__rail")?.getBoundingClientRect() : null;
    const [panelNode, panel] = all(".rm-panel").filter(visible).map((node) => [node, node.getBoundingClientRect()])
      .sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height)[0] ?? [];
    const footerNode = panelNode && [...panelNode.querySelectorAll(".rm-panel__footer")].filter(visible).pop();
    const footer = footerNode?.getBoundingClientRect();
    const header = panelNode && [...panelNode.querySelectorAll(".rm-panel__header")].find(visible)?.getBoundingClientRect();
    return {
      vw, vh, wide, top, rail, panel, footerNode,
      // Where the rail column's content ends, so the dock can sit under it.
      railEnd: rail ? Math.max(rail.top, ...all(`${RAIL} > *`).filter(visible).map((node) => node.getBoundingClientRect().bottom)) : 0,
      columnBottom: panel?.bottom ?? vh - 16,
      footerTop: footer && footer.top > (panel?.top ?? 0) ? footer.top : (panel?.bottom ?? vh) - 16,
      headerBottom: header?.bottom ?? (panel?.top ?? top) + 16,
      bottom: footer && footer.top < vh ? footer.top : vh,
    };
  }

  // A node's box inside the window below the top bar and inside every
  // ancestor that clips it, such as a scrolled panel body; null when hidden.
  function seen(node, clipTop) {
    const clips = [box(0, clipTop, doc.documentElement.clientWidth, innerHeight - clipTop)];
    for (let parent = node.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") clips.push(parent.getBoundingClientRect());
    }
    return visiblePart(node.getBoundingClientRect(), clips);
  }

  // A wrapper with display: contents has no box of its own, so it never counts
  // as showing, but its children have theirs. It shows nothing as the folded
  // part of a closed disclosure.
  const boxless = (item) => !item.hidden && getComputedStyle(item).display === "contents" &&
    !(item.parentElement?.matches("details:not([open])") && !item.matches("summary"));

  // What the action label must not cover near its target: every line of text
  // and every control within reach, apart from the target's own. Hidden
  // branches and branches out of reach are skipped whole; a boxless wrapper
  // is passed through to its children.
  function beside(node, anchor) {
    if (!doc.createTreeWalker || !doc.createRange) return [];
    const near = (rect) => rect.bottom > anchor.top - 48 && rect.top < anchor.bottom + 48;
    const found = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (item) => {
      if (item.nodeType !== 1) return item.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      if (item === node || owned(item) || item.matches(".rm-visually-hidden")) return NodeFilter.FILTER_REJECT;
      if (!showing(item)) return boxless(item) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
      const rect = item.getBoundingClientRect();
      if ((rect.width || rect.height) && !near(rect)) return NodeFilter.FILTER_REJECT;
      if (!item.matches(PRESSABLE) || item.contains(node)) return NodeFilter.FILTER_SKIP;
      found.push(rect);
      return NodeFilter.FILTER_REJECT;
    });
    const range = doc.createRange();
    while (walker.nextNode()) {
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) if (rect.width > 1 && near(rect)) found.push(rect);
    }
    return found;
  }

  function place() {
    const current = mode();
    const node = target(current);
    const errorHelp = current === "error" || (current === "help" && helpEntry().id === "error");
    if (node !== observedTarget) {
      if (observedTarget) sizes.unobserve(observedTarget);
      if (node) sizes.observe(node);
      observedTarget = node;
    }
    const view = layout();
    const goal = node && seen(node, view.top - 8);
    const was = { dock: !ui.dock.hidden, chip: !ui.chip.hidden };
    // Never covered: the focused element, the primary action, alerts, the
    // panel footer's actions and consents, the controls of a region the page
    // keeps clear with data-guide-keep, such as the selected connection, and,
    // while error help shows, the field the failure names or the page marked.
    const hard = [];
    const focused = doc.activeElement;
    if (focused && !owned(focused)) {
      const rect = focused.getBoundingClientRect();
      if (rect.width * rect.height < (view.vw * view.vh) / 3) hard.push(rect);
    }
    const urgent = boxes([...all(".rm-button--primary, [role='alert'], .rm-panel__footer :is(button, a[href], label)"),
      ...all("[data-guide-keep]").flatMap((region) => [...region.querySelectorAll("button, a[href]")]),
      ...(errorHelp ? [node, ...all("[aria-invalid='true']")] : [])]);
    hard.push(...urgent);
    const track = first(".rm-stepper--track");
    const safety = boxes(all(SAFETY).filter((item) => !item.contains(track)));
    // Boxes of the nodes on screen, each cut to the panel body that scrolls it.
    const bodies = new Map();
    const onScreen = (nodes) => nodes.flatMap((item) => {
      if (!visible(item)) return [];
      const body = item.closest(".rm-panel__body");
      if (body && !bodies.has(body)) bodies.set(body, body.getBoundingClientRect());
      const rect = item.getBoundingClientRect();
      const part = body ? visiblePart(rect, [bodies.get(body)]) : rect;
      return part && part.width > 1 && part.height > 1 ? [part] : [];
    });
    // The step's working controls, as far as their panel body shows them.
    const work = onScreen(all(WORK).filter((item) => item.closest(".rm-panel__body")));
    // The cursor and its action label are measured on screen before placing.
    const tip = demoTip ?? chapterNow()?.tips[tipIndex];
    const text = current === "help" ? inferAction(node) : demoTip ? demoTip.title : current !== "error" && ACTION_LABELS[tip?.action] || inferAction(node);
    if (ui.label.textContent !== text) ui.label.textContent = text;
    ui.pointer.hidden = false;
    const [tall, labelHeight] = [ui.cursor.offsetHeight, ui.label.offsetHeight];
    const arrow = ui.cursor.offsetWidth - ui.label.offsetWidth;
    const control = node?.matches(CHOICE) ? node : node?.matches("label") ? node.querySelector(CHOICE) : null;
    const anchor = (control && seen(control, view.top - 8)) || goal;
    // The label sits `tall - labelHeight` under the cursor's top, or that far
    // above its foot when raised.
    const cursor = anchor && cursorSpot(anchor, {
      arrow, width: ui.label.offsetWidth, height: labelHeight, top: tall - labelHeight,
    }, view, [...urgent, ...safety, ...boxes(all(LABELS)), ...beside(node, anchor)], Boolean(control));
    // Prefer spots that also keep the pointed target and the cursor in view; a
    // target taller than half the window is only highlighted.
    const aim = [];
    if (goal && goal.height < (view.vh - view.top) / 2) {
      const width = cursor.label ? ui.cursor.offsetWidth : arrow;
      aim.push(box(goal.left - 10, goal.top - 10, goal.width + 20, goal.height + 20),
        box(cursor.flip ? cursor.x - width : cursor.x, cursor.raise ? cursor.y - tall : cursor.y, width, tall));
    }
    const soft = [];
    for (const item of all(SOFT)) {
      const rect = item.getBoundingClientRect();
      if (rect.width > 0 && rect.bottom > 0 && rect.top < view.vh && !owned(item) && visible(item)) {
        soft.push({ ...box(rect.left, rect.top, rect.width, rect.height), weight: item.matches(CONTROLS) ? 3 : 1 });
      }
    }
    // On phones the walkthrough plays on a clear screen: the dock fades out but
    // keeps its place and any focus inside it, and returns when the demo ends.
    const clear = Boolean(demo) && !view.wide;
    ui.dock.classList.toggle("is-clear", clear);
    const sets = { hard, safety, lead: boxes(all(LEAD)), aim, work, fixed: errorHelp ? work : [] };
    // The rail column alone, and everything a dock nobody opened keeps clear
    // with 8 px of air, to find the stretches of that column still free.
    const column = view.wide && view.rail ? { ...view, panel: null } : null;
    const keep = [...hard, ...safety, ...work, ...sets.lead, ...aim]
      .map((rect) => box(rect.left, rect.top - 8, rect.width, rect.height + 16));
    let spot = null;
    if (current !== "chip") {
      ui.dock.hidden = false;
      const opened = openedKey === shownKey || ui.dock.contains(doc.activeElement);
      spot = placeDock(candidates(view, natural), sets, soft, opened,
        opened ? boundedSpots(view, natural, [...hard, ...sets.fixed]) : column ? boundedSpots(column, natural, keep, SHRUNK) : []);
    }
    // A dock that folds into the chip hands its focus to the chip.
    const refocus = !spot && ui.dock.contains(doc.activeElement);
    ui.dock.hidden = !spot;
    ui.chip.hidden = Boolean(spot);
    if (spot) move(ui.dock, spot, was.dock);
    else {
      // The chip also keeps every link, button, choice and heading on the page clear.
      move(ui.chip, chipSpot(view, ui.chip.offsetWidth, ui.chip.offsetHeight,
        { ...sets, taps: onScreen(all(TAPS)), headings: onScreen(all(HEADINGS)) }, soft), was.chip);
      if (refocus) ui.chip.focus();
    }
    drift = false;
    const shield = spot ?? ui.chip.getBoundingClientRect();
    const off = !goal || current === "chip" || (!view.wide && ((!clear && overlaps(goal, shield)) ||
      (goal.top >= view.bottom && !view.footerNode?.contains(node))));
    ui.pointer.hidden = off;
    if (off) return;
    const pad = 4;
    ui.ring.style.width = `${Math.round(goal.width + 2 * pad)}px`;
    ui.ring.style.height = `${Math.round(goal.height + 2 * pad)}px`;
    ui.ring.style.transform = `translate(${Math.round(goal.left - pad)}px, ${Math.round(goal.top - pad)}px)`;
    ui.cursor.classList.toggle("is-flipped", cursor.flip);
    ui.cursor.classList.toggle("is-raised", cursor.raise);
    ui.cursor.classList.toggle("is-bare", !cursor.label);
    ui.cursor.style.transform = `translate(${Math.round(cursor.x)}px, ${Math.round(cursor.y)}px)`;
    if (spot) {
      const dx = goal.left + goal.width / 2 - (spot.left + 32);
      const dy = goal.top + goal.height / 2 - (spot.top + 36);
      const length = Math.hypot(dx, dy) || 1;
      look = { dx: (dx / length) * 4, dy: (dy / length) * 4 };
      if (ui.mascot.getAttribute("data-pose") === "look") setMascotPose(ui.mascot, "look", look);
    }
  }

  // The dock's full height at a width.
  function natural(width) {
    ui.dock.style.width = `${width}px`;
    ui.dock.style.maxHeight = "";
    ui.dock.classList.remove("is-cut");
    return ui.dock.offsetHeight;
  }

  // Puts the dock or the chip at its spot. It moves at once, so it never
  // trails over page controls. At a new spot it fades in, except while the
  // page scrolls or resizes under it.
  function move(node, rect, shown) {
    // A dock cut shorter than its content scrolls its body.
    if (node === ui.dock && rect.height < natural(rect.width)) {
      node.style.maxHeight = `${rect.height}px`;
      node.classList.add("is-cut");
    }
    const value = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
    if (shown && node.style.transform === value) return;
    node.style.transform = value;
    if (!drift) node.dataset.arrive = node.dataset.arrive === "a" ? "b" : "a";
  }

  function inferAction(node) {
    if (node?.matches?.("input[type=checkbox], input[type=radio]")) return ACTION_LABELS.check;
    if (node?.matches?.("select")) return ACTION_LABELS.choose;
    if (node?.matches?.("input, textarea")) return ACTION_LABELS.type;
    return node?.matches?.("button, a, summary") ? ACTION_LABELS.press : ACTION_LABELS.read;
  }

  // Show me: play the chapter's tips in order, then bring the current target
  // into view and focus it. Reduced motion numbers the targets instead.
  function showMe() {
    stopDemo();
    clearMarkers();
    const current = mode();
    const goal = target(current);
    const chapter = chapterNow();
    const tips = current === "guide" && chapter ? chapter.tips.filter((tip) => shown(tip.target)) : [];
    if (tips.length < 2) return reveal(goal);
    if (reduced()) {
      // The current target comes into view first, so each marker lands on its
      // target; then the markers are numbered without overlapping.
      reveal(goal);
      const spots = tips.map((tip, index) => {
        const marker = make("div", "rm-guide-marker");
        marker.append(make("span", "rm-guide-marker__number", String(index + 1)), make("span", "", tip.title));
        ui.layer.append(marker);
        markers.push(marker);
        const rect = first(tip.target).getBoundingClientRect();
        return box(rect.left, Math.max(0, rect.top - 30), marker.offsetWidth, marker.offsetHeight);
      });
      stackMarkers(spots, doc.documentElement.clientWidth).forEach((spot, index) => {
        markers[index].style.transform = `translate(${Math.round(spot.left)}px, ${Math.round(spot.top)}px)`;
      });
      return;
    }
    const wait = Math.min(900, 4200 / tips.length);
    let index = 0;
    const next = () => {
      demoTip = tips[index++] ?? null;
      place();
      if (demoTip) demo = setTimeout(next, wait);
      else {
        demo = null;
        place();
        reveal(goal);
      }
    };
    demo = setTimeout(next, 0);
  }

  function stopDemo() {
    if (!demo) return;
    clearTimeout(demo);
    demo = demoTip = null;
    placeSoon();
  }

  function clearMarkers() {
    for (const marker of markers) marker.remove();
    markers = [];
  }

  // Scroll the target into the part of the window the dock leaves free.
  function reveal(node) {
    if (!node) return;
    const view = layout();
    const rect = node.getBoundingClientRect();
    const behavior = reduced() ? "auto" : "smooth";
    let [low, high] = [view.top, view.bottom];
    if (!view.wide && !ui.dock.hidden) {
      const sheet = ui.dock.getBoundingClientRect();
      if (sheet.top - low >= high - sheet.bottom) high = Math.min(high, sheet.top);
      else low = Math.max(low, sheet.bottom);
    }
    if (rect.top < low || rect.bottom > high) {
      if (view.wide) node.scrollIntoView({ block: "center", behavior });
      else scrollBy({ top: rect.top - low - Math.max(0, (high - low - rect.height) / 2), behavior });
    }
    let focusable = node.matches(FOCUSABLE) ? node : node.querySelector(FOCUSABLE);
    if (!focusable) {
      focusable = node;
      node.tabIndex = -1;
      node.addEventListener("blur", () => node.removeAttribute("tabindex"), { once: true });
    }
    if (!focusable.disabled) focusable.focus({ preventScroll: true });
    ui.pointer.classList.remove("is-pulsing");
    void ui.pointer.offsetWidth;
    ui.pointer.classList.add("is-pulsing");
    setTimeout(() => ui.pointer.classList.remove("is-pulsing"), 1300);
  }

  function refresh() {
    evaluate();
    render();
    place();
  }

  function schedule() {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }

  function placeSoon() {
    placeFrame ||= requestAnimationFrame(() => {
      placeFrame = 0;
      place();
    });
  }

  const sizes = new ResizeObserver(placeSoon);
  sizes.observe(ui.dock);
  // Ignore the guide's own changes, including moving the mascot along the track.
  new MutationObserver((records) => {
    if (records.some((record) => !owned(record.target) && (record.type === "childList"
      ? [...record.addedNodes, ...record.removedNodes].some((node) => node !== ui.track)
      : /^(?:hidden|class|open|disabled|checked|value|data-|aria-)/u.test(record.attributeName)))) schedule();
  }).observe(doc.body, { subtree: true, childList: true, attributes: true });
  for (const type of ["input", "change", "click"]) {
    doc.addEventListener(type, (event) => {
      if (owned(event.target)) return;
      const chapter = chapterNow();
      const kind = { click: "clicked", change: "changed" }[type];
      for (const tip of kind && chapter ? chapter.tips : []) {
        if (tip.done !== kind || !matches(event.target, tip.target)) continue;
        const key = `${kind}|${chapter.id}/${tip.id}`;
        // A press waits for its result; a changed choice counts at once.
        if (kind === "clicked" && !marks.has(key)) pending.set(key, { failure: host.failure, failureCount: host.failureCount ?? 0, tip, chapter, copy: copyButton(event.target.closest(tip.target)) });
        else marks.add(key);
      }
      schedule();
    }, true);
  }
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    doc.addEventListener(type, () => { stopDemo(); clearMarkers(); }, { capture: true, passive: true });
  }
  const drifted = () => { drift = true; placeSoon(); };
  addEventListener("resize", drifted, { passive: true });
  doc.addEventListener("scroll", drifted, { capture: true, passive: true });
  doc.addEventListener("focusin", follow, true);
  doc.addEventListener("focusout", (event) => { if (event.relatedTarget) placeSoon(); else follow(event); }, true);
  return { refresh: schedule, openHelp };
}
