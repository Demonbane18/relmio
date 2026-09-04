(() => {
  const transferredName = window.name;
  window.name = "";

  const match = /^relmio-v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(
    transferredName,
  );
  const routes = new Set(["/", "/assistant", "/local"]);
  const route = window.location.pathname;

  if (!match || !routes.has(route) || window.location.search !== "") {
    window.__relmioWizardSessionReady = Promise.resolve(null);
    return;
  }

  const currentCleanLocation = () =>
    `${window.location.pathname}${window.location.hash ?? ""}`;
  let request;
  try {
    request = fetch("/__relmio/browser/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        route,
        transferId: match[1],
        secret: match[2],
      }),
      cache: "no-store",
      credentials: "omit",
      mode: "same-origin",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    request = Promise.reject(error);
  }

  window.__relmioWizardSessionReady = Promise.resolve(request)
    .then(async (response) => {
      if (!response?.ok) throw new Error("Browser transfer failed.");
      const body = await response.json();
      if (
        !body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).join("\0") !== "sessionToken" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(body.sessionToken) ||
        window.location.pathname !== route || window.location.search !== ""
      ) throw new Error("Browser transfer failed.");
      window.history.replaceState(
        { relmioWizardSession: body.sessionToken },
        "",
        currentCleanLocation(),
      );
      return null;
    })
    .catch(() => {
      if (routes.has(window.location.pathname)) {
        window.history.replaceState(null, "", currentCleanLocation());
      }
      return null;
    });
})();
