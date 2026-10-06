// Setup guide dock: screen tracking, the dock and its mascot chip, the pointer,
// Show me, the mascot in the quest track and the badges on Ready screens.
// guide.js imports this module only while the guide or error help is in use,
// so pages with the guide off never load it.
import { ACTION_LABELS, box, choosePlacement, currentTip, errorTarget, overlaps, selectChapter, tipDone, visitOutcome } from "./guide.js";
import { createMascot, setMascotPose } from "./mascot.js";

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";
// Page content the dock should avoid covering when it has a choice; covering
// a control costs three times as much as covering text.
const SOFT = ".rm-split__rail > *, .rm-split > :not(.rm-split__rail, .rm-split__content, .rm-panel), .rm-panel__heading," +
  " .rm-split__rail :is(button:not(:disabled), a[href], summary), .rm-panel__body :is(.rm-field, .rm-check, .rm-choice," +
  " .rm-callout, .rm-notice, .rm-card, .rm-dl, .rm-disclosure, .rm-terminal, .rm-table-wrap, p, h2, h3, li, button, a, label)";
const CONTROLS = "button, a, label, .rm-field, .rm-check, .rm-choice, .rm-disclosure";

export function mountGuide(host) {
  const doc = document;
  const { page, toggles } = host;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  let active = -1; let tipIndex = -1; let viewTip = null; let finished = false; let happyUntil = 0;
  let visitShown = new Set(); let visitDone = new Set();
  const marks = new Set(); const completed = new Set(); const earned = [];
  let hidden = false; let errorOpen = false; let seenFailure = null; let seenPref; let returnFocus = null;
  let demo = null; let demoTip = null; let markers = []; let look = {};
  let frame = 0; let placeFrame = 0; let shownKey = ""; let observedTarget = null;

  const all = (selector) => { try { return [...doc.querySelectorAll(selector)]; } catch { return []; } };
  const owned = (node) => toggles.includes(node) || ui.layer.contains(node) || ui.track.contains(node) ||
    Boolean(ui.finish?.contains(node));
  const showing = (node) => (node.checkVisibility ? node.checkVisibility() : node.getClientRects().length > 0);
  const visible = (node) => Boolean(node) && !ui.layer.contains(node) && showing(node);
  const first = (selector) => (typeof selector === "string" ? all(selector).find(visible) ?? null : null);
  const shown = (selector) => first(selector) !== null;
  const matches = (node, selector) => { try { return Boolean(node?.closest?.(selector)); } catch { return false; } };
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
    filled: (selector) => all(selector).some((node) => visible(node) && String(node.value ?? "").trim() !== ""),
    checked: (selector) => all(selector).some((node) => node.checked === true || Boolean(node.querySelector?.("input:checked"))),
    marked: (tip, kind) => marks.has(`${kind}|${chapter.id}/${tip.id}`),
  });
  const chapterNow = () => host.content?.chapters[active];

  const ui = build();

  function build() {
    const layer = make("div", "rm-guide-layer");
    const dock = make("aside", "rm-guide");
    dock.setAttribute("aria-label", "Setup guide");
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
    live.setAttribute("aria-live", "polite");
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
    const actions = make("div", "rm-guide__actions");
    const back = iconButton("arrow-left", "Back", "rm-icon-button--outline");
    const forward = textButton("rm-button rm-button--sm", "Next tip");
    const show = textButton("rm-button rm-button--sm", "Show me");
    const start = textButton("rm-button rm-button--sm", "Start the guide");
    const skip = textButton("rm-button rm-button--ghost rm-button--sm", "Skip guide");
    actions.append(back, forward, show, start, skip);
    dock.append(head, live, example, find, next, actions);
    const chip = textButton("rm-guide-chip");
    const chipFace = make("span", "rm-guide-chip__mascot");
    const chipMascot = createMascot();
    chipFace.append(chipMascot);
    const chipText = make("span");
    chip.append(chipFace, chipText);
    const pointer = make("div", "rm-guide-pointer");
    pointer.setAttribute("aria-hidden", "true");
    const ring = make("div", "rm-guide-pointer__ring");
    const cursor = make("div", "rm-guide-pointer__cursor");
    const label = make("span", "rm-guide-pointer__label");
    cursor.append(make("span", "rm-guide-pointer__arrow"), label);
    pointer.append(ring, cursor);
    dock.hidden = chip.hidden = pointer.hidden = true;
    layer.append(pointer, dock, chip);
    doc.body.append(layer);
    // A tighter view box for the quest track; the cap and warning mark may spill.
    const track = createMascot();
    track.setAttribute("viewBox", "-6 -6 108 138");
    const finish = doc.querySelector("[data-guide-finish]");

    const collapse = () => { hidden = true; errorOpen = false; refresh(); };
    // Focus moves to the visible guide toggle, or the menu that holds it.
    const turnOff = () => {
      host.choose("off");
      (toggles.find((node) => node.checkVisibility?.()) ?? doc.querySelector(".rm-menu > summary"))?.focus();
    };
    hide.addEventListener("click", () => { collapse(); chip.focus(); });
    close.addEventListener("click", turnOff);
    skip.addEventListener("click", turnOff);
    start.addEventListener("click", () => { host.choose("on"); refresh(); focusDock(); });
    back.addEventListener("click", () => { if (back.getAttribute("aria-disabled") !== "true") step(-1); });
    forward.addEventListener("click", () => { if (forward.getAttribute("aria-disabled") !== "true") step(1); });
    show.addEventListener("click", showMe);
    chip.addEventListener("click", () => {
      hidden = false;
      if (host.failure?.entry) errorOpen = true;
      refresh();
      focusDock();
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
      next, actions, back, forward, show, start, skip, chip, chipMascot, chipText, pointer, ring, cursor, label, track, finish };
  }

  function focusDock() {
    (ui.dock.hidden ? ui.chip : ui.dock).focus();
  }

  function mode() {
    const { pref, content, failure } = host;
    if (failure !== seenFailure) [seenFailure, errorOpen] = [failure, false];
    if (pref !== seenPref) [seenPref, hidden] = [pref, false];
    const help = failure?.entry;
    if (help && (errorOpen || (pref !== "off" && !hidden))) return "error";
    if (help || (content && pref !== "off" && hidden)) return "chip";
    if (!content || pref === "off") return "none";
    return pref === null ? "welcome" : finished ? "finish" : "guide";
  }

  function award(chapter) {
    if (!chapter || completed.has(chapter.id)) return;
    completed.add(chapter.id);
    if (chapter.badge) earned.push(chapter.badge);
    happyUntil = performance.now() + 900;
    setTimeout(schedule, 950);
  }

  function evaluate() {
    const failure = host.failure;
    if (failure?.surfaces.length && !failure.surfaces.some(visible)) host.failure = null;
    const chapters = host.content?.chapters;
    if (!chapters) return;
    const visit = (chapter, current) => {
      const check = probe(chapter);
      return visitOutcome([...visitShown], (tip) => visitDone.has(tip) || tipDone(tip, check),
        { last: chapter === chapters.at(-1), current });
    };
    const index = selectChapter(chapters, shown);
    if (index !== active) {
      if (chapters[active] && visit(chapters[active]).badge) award(chapters[active]);
      [active, viewTip, finished, visitShown, visitDone] = [index, null, false, new Set(), new Set()];
      stopDemo();
      clearMarkers();
    }
    const chapter = chapters[active];
    if (!chapter) { tipIndex = -1; return; }
    const check = probe(chapter);
    for (const tip of chapter.tips) {
      if (!shown(tip.target)) continue;
      visitShown.add(tip);
      if (tipDone(tip, check)) visitDone.add(tip);
    }
    const current = currentTip(chapter.tips, check);
    if (viewTip?.base !== current) viewTip = null;
    tipIndex = viewTip?.index ?? (current >= 0 ? current : chapter.tips.findLastIndex((tip) => shown(tip.target)));
    const outcome = finished ? null : visit(chapter, current);
    if (outcome?.finished) {
      finished = true;
      if (outcome.badge) award(chapter);
    }
  }

  function step(delta) {
    const chapter = chapterNow();
    const tips = chapter?.tips ?? [];
    const tip = tips[tipIndex];
    if (!tip) return;
    if (delta > 0 && tip.done === "manual") marks.add(`manual|${chapter.id}/${tip.id}`);
    let index = tipIndex + delta;
    while (tips[index] && !shown(tips[index].target)) index += delta;
    viewTip = tips[index] ? { index, base: currentTip(tips, probe(chapter)) } : null;
    refresh();
  }

  function render() {
    const current = mode();
    if (current === "none") {
      ui.dock.hidden = ui.chip.hidden = ui.pointer.hidden = true;
      ui.track.remove();
      renderFinish(null);
      return;
    }
    const content = host.content;
    const chapter = chapterNow();
    const tip = current === "guide" ? chapter?.tips[tipIndex] : null;
    const entry = host.failure?.entry;
    const key = `${current}|${current === "guide" ? `${chapter?.id}/${tip?.id}` : current === "error" ? entry.title : ""}`;
    const focusInside = ui.dock.contains(doc.activeElement);
    // A Ready screen with the badges block lists them, so the dock does not repeat them.
    const listed = onPage(content);
    if (key !== shownKey && current !== "chip") {
      shownKey = key;
      const [title, say] = current === "error" ? [entry.title, entry.say]
        : current === "finish" ? [content.finish?.title ?? "Setup complete", content.finish?.say]
          : tip ? [tip.title, tip.say] : [content.title, content.intro];
      ui.title.textContent = title ?? "";
      ui.say.textContent = say ?? "";
      ui.steps.replaceChildren(...(current === "error" ? entry.steps ?? [] : []).map((text) => make("li", "", text)));
      ui.code.textContent = tip?.example ?? "";
      ui.findText.textContent = tip?.find ?? "";
      ui.find.open = false;
      ui.next.replaceChildren(...(current === "finish" && !listed ? content.finish?.next ?? [] : [])
        .map((text) => make("li", "", text)));
      ui.eyebrow.textContent = current === "error" ? "Error help" : current === "guide" && chapter
        ? `Quest ${active + 1} of ${content.chapters.length} · ${chapter.label}` : "Setup guide";
    }
    const chapters = current === "error" ? [] : content?.chapters ?? [];
    if (ui.dots.children.length !== chapters.length) ui.dots.replaceChildren(...chapters.map(() => make("li")));
    chapters.forEach((item, index) => attr(ui.dots.children[index], "data-state",
      completed.has(item.id) ? "done" : index === active && current === "guide" ? "current" : "todo"));
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
    ui.progress.hidden = current === "error";
    ui.back.hidden = ui.forward.hidden = ui.close.hidden = current !== "guide";
    attr(ui.back, "aria-disabled", String(!before));
    attr(ui.forward, "aria-disabled", String(!after));
    ui.show.hidden = !target(current);
    ui.start.hidden = ui.skip.hidden = current !== "welcome";
    ui.actions.hidden = [...ui.actions.children].every((node) => node.hidden);
    ui.chipText.textContent = entry ? "Need help with this error?" : "Guide";
    if (entry) ui.chip.removeAttribute("aria-label");
    else attr(ui.chip, "aria-label", "Show setup guide");
    setMascotPose(ui.chipMascot, entry ? "worried" : "idle");
    const pose = performance.now() < happyUntil ? "happy" : current === "error" ? "worried"
      : tip?.action === "wait" ? "waiting" : tip?.action === "read" ? "thinking" : tip ? "look" : "idle";
    setMascotPose(ui.mascot, pose, look);
    // Relmio stands in the quest track's current step while the guide is on.
    const step = host.pref === "on" && content ? first(".rm-stepper__item[aria-current='step'] .rm-stepper__marker") : null;
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
      columnBottom: panel?.bottom ?? vh - 16,
      footerTop: footer && footer.top > (panel?.top ?? 0) ? footer.top : (panel?.bottom ?? vh) - 16,
      headerBottom: header?.bottom ?? (panel?.top ?? top) + 16,
      bottom: footer && footer.top < vh ? footer.top : vh,
    };
  }

  // Wide screens: the step rail's foot or top, then corners of the panel above
  // its footer or under its header. Narrow screens: a sheet at the bottom of
  // the window, above the panel footer, or under the top bar.
  function candidates(view, measure) {
    const list = [];
    if (view.wide && view.rail) {
      const { left, top, width } = view.rail;
      const height = measure(width);
      list.push(box(left, view.columnBottom - height, width, height), box(left, top, width, height));
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

  function place() {
    const current = mode();
    const node = current === "none" ? null : target(current);
    if (node !== observedTarget) {
      if (observedTarget) sizes.unobserve(observedTarget);
      if (node) sizes.observe(node);
      observedTarget = node;
    }
    if (current === "none") return;
    const view = layout();
    const goal = node?.getBoundingClientRect();
    const x = goal && Math.min(goal.right - 12, view.vw - 24);
    const y = goal && Math.min(goal.bottom - 6, view.vh - 32);
    const flip = goal && x + ui.label.offsetWidth + 32 > view.vw;
    const guard = [];
    const focused = doc.activeElement;
    if (focused && !owned(focused)) {
      const rect = focused.getBoundingClientRect();
      if (rect.width * rect.height < (view.vw * view.vh) / 3) guard.push(rect);
    }
    for (const item of all(".rm-button--primary, [role='alert']")) if (visible(item)) guard.push(item.getBoundingClientRect());
    const blocked = guard.filter((rect) => rect.width > 0 && rect.height > 0);
    // Prefer spots that also keep the pointed target and the cursor label in
    // view; a target taller than half the window is only highlighted.
    const guarded = [...blocked];
    if (goal && goal.bottom > view.top && goal.top < view.vh && goal.height < (view.vh - view.top) / 2) {
      const width = ui.cursor.offsetWidth || 130;
      guarded.push(box(goal.left - 10, goal.top - 10, goal.width + 20, goal.height + 20),
        box(flip ? x - width : x, y, width, ui.cursor.offsetHeight || 40));
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
    let spot = null;
    if (current !== "chip") {
      ui.dock.hidden = false;
      const list = candidates(view, (width) => {
        ui.dock.style.width = `${width}px`;
        return ui.dock.offsetHeight;
      });
      spot = choosePlacement(list, guarded, soft) ?? choosePlacement(list, blocked, soft);
    }
    ui.dock.hidden = !spot;
    ui.chip.hidden = Boolean(spot);
    if (spot) move(ui.dock, spot);
    else {
      const width = ui.chip.offsetWidth;
      const height = ui.chip.offsetHeight;
      const gap = view.wide ? 16 : 8;
      const right = view.vw - gap - width;
      const list = [box(right, view.bottom - gap - height, width, height), box(right, view.top, width, height)];
      if (view.rail) list.unshift(box(view.rail.left, view.columnBottom - height, width, height));
      move(ui.chip, choosePlacement(list, blocked, soft) ?? list.at(-1));
    }
    const shield = spot ?? ui.chip.getBoundingClientRect();
    const off = !goal || goal.bottom < view.top || goal.top > view.vh || goal.right < 0 || goal.left > view.vw ||
      current === "chip" || (!view.wide && ((!clear && overlaps(goal, shield)) ||
        (goal.top >= view.bottom && !view.footerNode?.contains(node))));
    ui.pointer.hidden = off;
    if (off) return;
    const pad = 6;
    ui.ring.style.width = `${Math.round(goal.width + 2 * pad)}px`;
    ui.ring.style.height = `${Math.round(goal.height + 2 * pad)}px`;
    ui.ring.style.transform = `translate(${Math.round(goal.left - pad)}px, ${Math.round(goal.top - pad)}px)`;
    const tip = demoTip ?? chapterNow()?.tips[tipIndex];
    const text = demoTip ? demoTip.title : current !== "error" && ACTION_LABELS[tip?.action] || inferAction(node);
    if (ui.label.textContent !== text) ui.label.textContent = text;
    ui.cursor.classList.toggle("is-flipped", flip);
    ui.cursor.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (spot) {
      const dx = goal.left + goal.width / 2 - (spot.left + 32);
      const dy = goal.top + goal.height / 2 - (spot.top + 36);
      const length = Math.hypot(dx, dy) || 1;
      look = { dx: (dx / length) * 4, dy: (dy / length) * 4 };
      if (ui.mascot.getAttribute("data-pose") === "look") setMascotPose(ui.mascot, "look", look);
    }
  }

  function move(node, rect) {
    if (node === ui.dock) node.style.width = `${rect.width}px`;
    const value = `translate(${Math.round(rect.left)}px, ${Math.round(rect.top)}px)`;
    if (node.style.transform !== value) node.style.transform = value;
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
      tips.forEach((tip, index) => {
        const rect = first(tip.target).getBoundingClientRect();
        const marker = make("div", "rm-guide-marker");
        marker.append(make("span", "rm-guide-marker__number", String(index + 1)), make("span", "", tip.title));
        marker.style.transform = `translate(${Math.round(rect.left)}px, ${Math.round(Math.max(0, rect.top - 30))}px)`;
        ui.layer.append(marker);
        markers.push(marker);
      });
      return reveal(goal);
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
        if (tip.done === kind && matches(event.target, tip.target)) marks.add(`${kind}|${chapter.id}/${tip.id}`);
      }
      schedule();
    }, true);
  }
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    doc.addEventListener(type, () => { stopDemo(); clearMarkers(); }, { capture: true, passive: true });
  }
  addEventListener("resize", placeSoon, { passive: true });
  doc.addEventListener("scroll", placeSoon, { capture: true, passive: true });
  doc.addEventListener("focusin", placeSoon);
  doc.addEventListener("focusout", placeSoon);
  return { refresh: schedule };
}
