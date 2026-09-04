const WIZARD_SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const WIZARD_ROUTES = new Set(["/", "/assistant", "/local"]);
const fragmentSessionWindows = new WeakSet();

const pendingBrowserTransfer = globalThis.__relmioWizardSessionReady;
if (pendingBrowserTransfer && typeof pendingBrowserTransfer.then === "function") {
  try { await pendingBrowserTransfer; } catch { /* The bootstrap fails closed. */ }
  try { delete globalThis.__relmioWizardSessionReady; } catch {
    globalThis.__relmioWizardSessionReady = null;
  }
}

function validWizardSession(value) {
  return typeof value === "string" && WIZARD_SESSION_PATTERN.test(value);
}

function cleanWizardLocation(location) {
  return `${location.pathname}${location.hash ?? ""}`;
}

function preserveFragmentSession(browserWindow, session) {
  if (
    !validWizardSession(session) ||
    !browserWindow ||
    (typeof browserWindow !== "object" && typeof browserWindow !== "function") ||
    typeof browserWindow.addEventListener !== "function" ||
    fragmentSessionWindows.has(browserWindow)
  ) return;

  fragmentSessionWindows.add(browserWindow);
  browserWindow.addEventListener("hashchange", () => {
    browserWindow.history.replaceState(
      { relmioWizardSession: session },
      "",
      cleanWizardLocation(browserWindow.location),
    );
  });
}

export function readWizardSession(browserWindow = window) {
  const { history, location } = browserWindow;
  const historySession = validWizardSession(
    history.state?.relmioWizardSession,
  )
    ? history.state.relmioWizardSession
    : null;
  const session = historySession;
  const cleanLocation = cleanWizardLocation(location);

  history.replaceState(
    session ? { relmioWizardSession: session } : null,
    "",
    cleanLocation,
  );
  preserveFragmentSession(browserWindow, session);
  return session;
}

export function bindWizardNavigation(
  link,
  path,
  session,
  browserWindow = window,
) {
  if (!link?.setAttribute || !link?.addEventListener) {
    throw new TypeError("A wizard navigation link is required.");
  }
  if (!WIZARD_ROUTES.has(path)) {
    throw new TypeError("The wizard navigation route is invalid.");
  }

  link.setAttribute("href", path);
  link.addEventListener("click", (event) => {
    const target = link.getAttribute?.("target") || link.target;
    const modified =
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey;

    if (
      event.defaultPrevented ||
      modified ||
      (target && target.toLowerCase() !== "_self") ||
      !validWizardSession(session)
    ) {
      return;
    }

    event.preventDefault();
    browserWindow.history.pushState(
      { relmioWizardSession: session },
      "",
      path,
    );
    browserWindow.location.reload();
  });
}
