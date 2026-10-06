// Relmio setup guide. Every wizard page loads this module and names itself in
// <body data-guide-page>. It stays small: the dock (/guide-dock.js) and the
// page's content (/guide/content-<page>.js) load only while the guide is on,
// and /guide/errors.js only on the first error. Pure helpers are exported for
// the dock and for tests; the bootstrap runs only inside a page.

export const GUIDE_PAGES = Object.freeze(["vps", "local", "assistant", "supergrok-vps", "local-model-vps", "hosting"]);
export const ACTION_LABELS = Object.freeze({
  type: "Type here", press: "Press this", choose: "Choose one", check: "Tick this", read: "Read this", wait: "Wait here",
});
export const ERROR_FLAGS = Object.freeze([
  "retryBlocked", "oauthRetryBlocked", "remoteOutcomeUnknown", "managedPartialStack", "retryableNgrokSetup", "retryablePlan",
]);

// The first chapter whose panel is on screen, or -1.
export function selectChapter(chapters, shown) {
  return chapters.findIndex((chapter) => shown(chapter.panel));
}

// probe: { shown(selector), filled(selector), checked(selector), marked(tip, kind) }
export function tipDone(tip, probe) {
  const done = String(tip.done ?? "manual");
  const at = done.indexOf(":");
  const kind = at < 0 ? done : done.slice(0, at);
  if (kind === "filled") return probe.filled(tip.target);
  if (kind === "checked") return probe.checked(tip.target);
  if (kind === "visible") return probe.shown(done.slice(at + 1));
  if (kind === "hidden") return !probe.shown(done.slice(at + 1));
  return probe.marked(tip, kind);
}

// The first tip whose target is on screen and not done yet, or -1.
export function currentTip(tips, probe) {
  return tips.findIndex((tip) => probe.shown(tip.target) && !tipDone(tip, probe));
}

const own = (table, key) => (typeof key === "string" && table && Object.hasOwn(table, key) ? table[key] : null);

// Error flags, then codes, recovery (unless none), HTTP status, then the fallback.
export function lookupError(errors, error) {
  if (!errors || !error) return null;
  for (const flag of ERROR_FLAGS) if (error[flag] === true && own(errors.codes, flag)) return errors.codes[flag];
  for (const key of [error.code, error.errorCode, error.stoppedReason]) {
    if (own(errors.codes, key)) return errors.codes[key];
  }
  if (error.recovery !== "none" && own(errors.recovery, error.recovery)) return errors.recovery[error.recovery];
  return own(errors.status, error.status == null ? null : String(error.status)) ?? errors.fallback ?? null;
}

// The control that fixes an error: the entry's target on this page, else the named field.
export function errorTarget(entry, error, page) {
  const target = own(entry?.targets, page);
  if (target) return target;
  const param = error?.param;
  return /^[A-Za-z][\w-]{0,63}$/u.test(param ?? "") ? `#${param}, [name="${param}"]` : null;
}

// Only the fields the lookup reads, so page errors never carry more into the guide.
export function errorInfo(error) {
  const info = {};
  for (const key of ["code", "errorCode", "stoppedReason", "recovery", "param"]) {
    if (typeof error?.[key] === "string" && error[key].length <= 128) info[key] = error[key];
  }
  if (Number.isInteger(error?.status)) info.status = error.status;
  for (const flag of ERROR_FLAGS) if (error?.[flag] === true) info[flag] = true;
  return info;
}

export const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
export const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const covered = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

// The candidate that overlaps no protected rect and covers the least content.
// A soft rect may carry a weight, so covering controls costs more than text.
export function choosePlacement(candidates, protectedRects, softRects = []) {
  let best = null;
  let least = Infinity;
  for (const candidate of candidates) {
    if (protectedRects.some((rect) => overlaps(candidate, rect))) continue;
    const area = softRects.reduce((sum, rect) => sum + covered(candidate, rect) * (rect.weight ?? 1), 0);
    if (area < least) [best, least] = [candidate, area];
  }
  return best;
}

const page = globalThis.document?.body?.dataset.guidePage;
if (GUIDE_PAGES.includes(page)) boot(page);

function boot(page) {
  const KEY = "relmio-guide";
  const toggles = [...document.querySelectorAll("#guide-toggle, [data-guide-toggle]")];
  let stored = null;
  try { stored = sessionStorage.getItem(KEY); } catch {}
  let dock; let dockLoad; let contentLoad; let errorsLoad; let applied = false;
  const host = {
    page, toggles, content: undefined, failure: null,
    pref: stored === "on" || stored === "off" ? stored : null,
    choose(value) {
      void api({ guide: value });
      apply(value);
    },
  };

  async function api(body) {
    try {
      await globalThis.__relmioWizardSessionReady;
      const token = history.state?.relmioWizardSession;
      if (!token) return null;
      const response = await fetch("/api/ui/preferences", {
        method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, cache: "no-store",
        headers: { "Content-Type": "application/json", "X-Setup-Token": token },
      });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }

  function apply(value) {
    applied = true;
    host.pref = value;
    try { if (value) sessionStorage.setItem(KEY, value); else sessionStorage.removeItem(KEY); } catch {}
    for (const toggle of toggles) {
      if (toggle.getAttribute("aria-pressed") !== String(value === "on")) toggle.setAttribute("aria-pressed", String(value === "on"));
    }
    if (value !== "off") {
      contentLoad ??= import(`/guide/content-${page}.js`).then(
        (module) => { host.content = Array.isArray(module.GUIDE?.chapters) ? module.GUIDE : null; },
        () => { host.content = null; },
      );
      void Promise.all([contentLoad, mount()]).then(() => {
        if (!host.content) for (const toggle of toggles) toggle.hidden = true;
        dock?.refresh();
      });
    }
    dock?.refresh();
  }

  function mount() {
    dockLoad ??= import("/guide-dock.js").then((module) => { dock = module.mountGuide(host); }, () => {});
    return dockLoad;
  }

  globalThis.relmioGuide = Object.freeze({
    error(error) {
      const info = errorInfo(error);
      const record = host.failure = { info, surfaces: [...document.querySelectorAll("[role='alert']")].filter(isShown), entry: null };
      errorsLoad ??= import("/guide/errors.js").then((module) => module.GUIDE_ERRORS ?? null, () => null);
      void Promise.all([errorsLoad, mount()]).then(([errors]) => {
        if (host.failure !== record) return;
        record.entry = lookupError(errors, info);
        dock?.refresh();
      });
    },
    clearError() {
      host.failure = null;
      dock?.refresh();
    },
  });

  for (const toggle of toggles) {
    toggle.hidden = false;
    toggle.addEventListener("click", () => host.choose(host.pref === "on" ? "off" : "on"));
  }
  if (host.pref) apply(host.pref);
  void api().then((saved) => {
    const value = saved?.guide === "on" || saved?.guide === "off" ? saved.guide : saved ? null : host.pref;
    if (!applied || value !== host.pref) apply(value);
  });
}

function isShown(node) {
  return node.checkVisibility ? node.checkVisibility() : node.getClientRects().length > 0;
}
